package com.zvn.markie.mobile;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Files and folders on this device that the person let Markie use
 * (src/lib/local-files.ts is the page's side).
 *
 * Everything goes through the Storage Access Framework. The app asks for no
 * storage permission: the person picks a file or a folder in the system's own
 * picker, and that pick is the permission. It is kept across restarts with
 * takePersistableUriPermission and remembered here as a grant.
 *
 * The rules this file keeps, every time:
 *   - The page never sends a URI. It names a grant by id, and for a folder a
 *     document id inside it. The URI is always built from the grant's own
 *     tree, and the system refuses a document that is not under that tree.
 *   - The new bytes are whole, in memory, before the file is opened to write.
 *   - A file is opened "rwt", which truncates. Plain "w" does not: it leaves
 *     the end of the old text behind when the new text is shorter.
 *   - A save says which bytes it started from. If the file holds anything
 *     else by then, nothing is written.
 *   - What was written is read back and compared before the save counts.
 *
 * Nothing here goes to a server.
 */
@CapacitorPlugin(name = "MarkieLocalFiles")
public class LocalFilesPlugin extends Plugin {

    /** The same cap the page applies to a file from another app. */
    private static final int MAX_BYTES = 16 * 1024 * 1024;
    /** Single files are remembered as recents; the oldest go first. The system caps how many grants one app may hold. */
    private static final int MAX_FILE_GRANTS = 50;
    private static final String PREFS = "markie_local_files";
    private static final String KEY = "grants";
    private static final int READ_WRITE = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;

    private static final String[] DOCUMENT_TYPES = {
        "text/*",
        "application/json",
        "application/xml",
        "application/yaml",
        "application/x-yaml",
        "application/toml",
        "application/rtf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.oasis.opendocument.text",
        // Many storage providers know no better type for a .md or .wd file.
        "application/octet-stream",
    };

    /** A problem the page knows by its code. */
    private static final class LocalFilesException extends Exception {

        final String code;

        LocalFilesException(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    private static LocalFilesException unreachable() {
        return new LocalFilesException("unreachable", "Markie can't reach this any more.");
    }

    private static LocalFilesException missing() {
        return new LocalFilesException("missing", "This file was moved or deleted.");
    }

    private static final class Grant {

        String id;
        /** "file" or "folder". */
        String kind;
        String name;
        Uri uri;
        long usedAt;
        /** False for a file another app opened here without lasting permission: it works until the app closes. */
        boolean persisted = true;
    }

    /** Grants that last only as long as this run of the app. Never written down. */
    private final Map<String, Grant> sessionGrants = new ConcurrentHashMap<>();

    // ── Pickers ─────────────────────────────────────────────────────────────

    @PluginMethod
    public void pickDocument(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, DOCUMENT_TYPES);
        intent.addFlags(READ_WRITE | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "picked");
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(READ_WRITE | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        Intent data = result.getData();
        Uri uri = data == null ? null : data.getData();
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            call.resolve(new JSObject());
            return;
        }
        boolean folder = "pickFolder".equals(call.getMethodName());
        getBridge().execute(() -> {
            try {
                ContentResolver resolver = getContext().getContentResolver();
                // Kept across restarts. A provider that only lends reading
                // still opens; the page then shows the file as read-only.
                try {
                    resolver.takePersistableUriPermission(uri, READ_WRITE);
                } catch (SecurityException readOnly) {
                    resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                }
                Grant grant = remember(uri, folder ? "folder" : "file");
                JSObject out = new JSObject();
                out.put("grant", json(grant, true));
                call.resolve(out);
            } catch (Exception error) {
                call.reject("Markie couldn't keep access to that. Try choosing it again.", "failed");
            }
        });
    }

    // ── Grants ──────────────────────────────────────────────────────────────

    @PluginMethod
    public void grants(PluginCall call) {
        Set<String> held = new HashSet<>();
        for (UriPermission permission : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (permission.isReadPermission()) held.add(permission.getUri().toString());
        }
        JSArray list = new JSArray();
        for (Grant grant : stored()) {
            // The system drops a grant when the app's data is cleared, the
            // storage provider is removed or a card is taken out. It is still
            // listed, as one Markie can't reach, with a way to remove it.
            list.put(json(grant, held.contains(grant.uri.toString()) && exists(grant)));
        }
        JSObject out = new JSObject();
        out.put("grants", list);
        call.resolve(out);
    }

    @PluginMethod
    public void forget(PluginCall call) {
        String id = call.getString("grantId");
        sessionGrants.remove(id);
        List<Grant> all = stored();
        for (Grant grant : all) {
            if (!grant.id.equals(id)) continue;
            try {
                getContext().getContentResolver().releasePersistableUriPermission(grant.uri, READ_WRITE);
            } catch (SecurityException alreadyGone) {
                // Nothing left to give back.
            }
        }
        all.removeIf((grant) -> grant.id.equals(id));
        save(all);
        call.resolve();
    }

    /**
     * A content:// URI another app opened in Markie ("Open with"). When that
     * app lent writing too, the file is edited where it is: for good if the
     * permission can be kept, otherwise until the app closes. When it lent
     * reading only, nothing is adopted and the page opens a copy, as before.
     * Either way the file's real name comes back, which the URI rarely holds.
     */
    @PluginMethod
    public void adopt(PluginCall call) {
        JSObject out = new JSObject();
        String url = call.getString("url", "");
        Uri uri = Uri.parse(url);
        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme()) || isOwnProvider(uri)) {
            call.resolve(out);
            return;
        }
        Context context = getContext();
        String name = displayName(uri);
        if (name != null) out.put("name", name);
        boolean persisted = true;
        try {
            context.getContentResolver().takePersistableUriPermission(uri, READ_WRITE);
        } catch (SecurityException notLasting) {
            persisted = false;
        }
        if (!persisted && context.checkCallingOrSelfUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) {
            call.resolve(out);
            return;
        }
        Grant grant;
        if (persisted) {
            grant = remember(uri, "file");
        } else {
            grant = new Grant();
            grant.id = UUID.randomUUID().toString();
            grant.kind = "file";
            grant.name = name == null ? "Shared file" : name;
            grant.uri = uri;
            grant.usedAt = System.currentTimeMillis();
            grant.persisted = false;
            sessionGrants.put(grant.id, grant);
        }
        out.put("grant", json(grant, true));
        call.resolve(out);
    }

    // ── Files ───────────────────────────────────────────────────────────────

    @PluginMethod
    public void list(PluginCall call) {
        try {
            Grant grant = find(call.getString("grantId"));
            if (!"folder".equals(grant.kind)) throw unreachable();
            String entry = call.getString("entry");
            String parent = entry == null ? DocumentsContract.getTreeDocumentId(grant.uri) : entry;
            // One query for the whole folder. DocumentFile.listFiles asks the
            // provider again for every file, which is slow on a large folder.
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(grant.uri, parent);
            String[] columns = { Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_SIZE };
            JSArray entries = new JSArray();
            try (Cursor cursor = getContext().getContentResolver().query(children, columns, null, null, null)) {
                if (cursor == null) throw unreachable();
                while (cursor.moveToNext()) {
                    String name = cursor.getString(1);
                    if (name == null || name.startsWith(".")) continue;
                    JSObject item = new JSObject();
                    item.put("id", cursor.getString(0));
                    item.put("name", name);
                    item.put("folder", Document.MIME_TYPE_DIR.equals(cursor.getString(2)));
                    if (!cursor.isNull(3)) item.put("modified", cursor.getLong(3));
                    if (!cursor.isNull(4)) item.put("size", cursor.getLong(4));
                    entries.put(item);
                }
            }
            touch(grant);
            JSObject out = new JSObject();
            out.put("entries", entries);
            call.resolve(out);
        } catch (Exception error) {
            reject(call, error);
        }
    }

    @PluginMethod
    public void read(PluginCall call) {
        try {
            Grant grant = find(call.getString("grantId"));
            Uri uri = documentUri(grant, call.getString("entry"));
            byte[] bytes = readAll(uri);
            touch(grant);
            JSObject out = new JSObject();
            String name = displayName(uri);
            out.put("name", name == null ? grant.name : name);
            out.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
            out.put("hash", sha256(bytes));
            out.put("writable", writable(uri));
            Long modified = modified(uri);
            if (modified != null) out.put("modified", modified);
            call.resolve(out);
        } catch (Exception error) {
            reject(call, error);
        }
    }

    /**
     * Saves over the file. baseHash is the SHA-256 of the bytes the edit
     * started from: when the file holds anything else, nothing is written and
     * the page is told "changed". It is left out only after the person chose
     * to write over the other version.
     */
    @PluginMethod
    public void write(PluginCall call) {
        try {
            Grant grant = find(call.getString("grantId"));
            Uri uri = documentUri(grant, call.getString("entry"));
            String encoded = call.getString("data");
            if (encoded == null) throw new LocalFilesException("failed", "Nothing to save.");
            // All of the new text is in memory before the file is touched.
            byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
            String baseHash = call.getString("baseHash");
            if (baseHash != null && !baseHash.equals(sha256(readAll(uri)))) {
                throw new LocalFilesException("changed", "This file changed since it was opened.");
            }
            writeAll(uri, bytes);
            // The save only counts once the file reads back as what was sent.
            if (!sha256(bytes).equals(sha256(readAll(uri)))) {
                throw new LocalFilesException("failed", "The file didn't save correctly. Your text is still here. Try again.");
            }
            touch(grant);
            JSObject out = new JSObject();
            out.put("hash", sha256(bytes));
            Long modified = modified(uri);
            if (modified != null) out.put("modified", modified);
            call.resolve(out);
        } catch (Exception error) {
            reject(call, error);
        }
    }

    /** Makes a new file in a granted folder. The provider picks another name rather than replace one that is there. */
    @PluginMethod
    public void create(PluginCall call) {
        try {
            Grant grant = find(call.getString("grantId"));
            if (!"folder".equals(grant.kind)) throw unreachable();
            String name = call.getString("name", "");
            String encoded = call.getString("data");
            if (name.isEmpty() || name.contains("/") || encoded == null) throw new LocalFilesException("failed", "Nothing to save.");
            byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
            Uri parent = documentUri(grant, call.getString("parent"));
            // The file's own type when the system knows the extension, and the
            // plain "any file" type otherwise. Both keep the name as given.
            int dot = name.lastIndexOf('.');
            String known = dot < 0 ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
            Uri made = DocumentsContract.createDocument(getContext().getContentResolver(), parent, known == null ? "application/octet-stream" : known, name);
            if (made == null) throw new LocalFilesException("failed", "Markie couldn't make that file.");
            writeAll(made, bytes);
            if (!sha256(bytes).equals(sha256(readAll(made)))) {
                throw new LocalFilesException("failed", "The file didn't save correctly. Your text is still here. Try again.");
            }
            String madeName = displayName(made);
            JSObject entry = new JSObject();
            entry.put("id", DocumentsContract.getDocumentId(made));
            entry.put("name", madeName == null ? name : madeName);
            entry.put("folder", false);
            entry.put("size", bytes.length);
            JSObject out = new JSObject();
            out.put("entry", entry);
            call.resolve(out);
        } catch (Exception error) {
            reject(call, error);
        }
    }

    // ── The pieces ──────────────────────────────────────────────────────────

    /**
     * The document a call means. In a folder the URI is built from the
     * grant's own tree and the document id, so the system checks the document
     * is under that tree and refuses it otherwise (DocumentsProvider enforces
     * this for every tree URI). A single file is the grant itself and nothing else.
     */
    private Uri documentUri(Grant grant, String entry) throws LocalFilesException {
        if ("folder".equals(grant.kind)) {
            return DocumentsContract.buildDocumentUriUsingTree(grant.uri, entry == null ? DocumentsContract.getTreeDocumentId(grant.uri) : entry);
        }
        if (entry != null && !entry.isEmpty()) throw new LocalFilesException("outside", "That is outside what Markie was given.");
        return grant.uri;
    }

    private byte[] readAll(Uri uri) throws LocalFilesException {
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) throw unreachable();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                if (out.size() > MAX_BYTES) throw new LocalFilesException("too-large", "This file is too large to open on a phone.");
            }
            return out.toByteArray();
        } catch (FileNotFoundException gone) {
            throw missing();
        } catch (IOException | SecurityException | IllegalArgumentException | IllegalStateException error) {
            throw unreachable();
        }
    }

    private void writeAll(Uri uri, byte[] bytes) throws LocalFilesException {
        ContentResolver resolver = getContext().getContentResolver();
        ParcelFileDescriptor descriptor;
        try {
            try {
                // "t" cuts the file to nothing as it opens, so a shorter text
                // leaves none of the old one behind.
                descriptor = resolver.openFileDescriptor(uri, "rwt");
            } catch (IllegalArgumentException | UnsupportedOperationException | FileNotFoundException noReadWrite) {
                // Some providers refuse read-write. "wt" still truncates.
                descriptor = resolver.openFileDescriptor(uri, "wt");
            }
        } catch (FileNotFoundException gone) {
            throw missing();
        } catch (SecurityException | IllegalArgumentException | IllegalStateException | UnsupportedOperationException error) {
            throw unreachable();
        }
        if (descriptor == null) throw unreachable();
        try (ParcelFileDescriptor held = descriptor; FileOutputStream out = new FileOutputStream(held.getFileDescriptor())) {
            out.write(bytes);
            out.flush();
            try {
                // For a provider that ignored the "t": the file ends where the new text ends.
                out.getChannel().truncate(bytes.length);
            } catch (IOException | UnsupportedOperationException notSeekable) {
                // A pipe can't be cut. The read-back after this catches a wrong length.
            }
            try {
                out.getFD().sync();
            } catch (IOException notSyncable) {
                // Not every provider hands out a real file.
            }
        } catch (IOException error) {
            throw new LocalFilesException("failed", "Markie couldn't save this file. Your text is still here.");
        }
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            return cursor != null && cursor.moveToFirst() ? cursor.getString(0) : null;
        } catch (Exception error) {
            return null;
        }
    }

    private Long modified(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { Document.COLUMN_LAST_MODIFIED }, null, null, null)) {
            return cursor != null && cursor.moveToFirst() && !cursor.isNull(0) ? cursor.getLong(0) : null;
        } catch (Exception error) {
            return null;
        }
    }

    private boolean writable(Uri uri) {
        if (getContext().checkCallingOrSelfUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) return false;
        try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { Document.COLUMN_FLAGS }, null, null, null)) {
            // A provider that doesn't say is taken at its word when the save is tried.
            if (cursor == null || !cursor.moveToFirst() || cursor.isNull(0)) return true;
            return (cursor.getInt(0) & Document.FLAG_SUPPORTS_WRITE) != 0;
        } catch (Exception error) {
            return true;
        }
    }

    private boolean exists(Grant grant) {
        try {
            Uri uri = documentUri(grant, null);
            try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { Document.COLUMN_DOCUMENT_ID }, null, null, null)) {
                return cursor != null && cursor.moveToFirst();
            }
        } catch (Exception error) {
            return false;
        }
    }

    /** Another app must never point Markie at Markie's own private files. */
    private boolean isOwnProvider(Uri uri) {
        String authority = uri.getAuthority();
        if (authority == null) return true;
        ProviderInfo provider = getContext().getPackageManager().resolveContentProvider(authority, 0);
        return provider != null && getContext().getPackageName().equals(provider.packageName);
    }

    private Grant find(String id) throws LocalFilesException {
        if (id == null) throw unreachable();
        Grant session = sessionGrants.get(id);
        if (session != null) return session;
        for (Grant grant : stored()) if (grant.id.equals(id)) return grant;
        throw unreachable();
    }

    private synchronized Grant remember(Uri uri, String kind) {
        List<Grant> all = stored();
        Grant grant = null;
        // The same file or folder chosen twice is one grant, not two.
        for (Grant known : all) if (known.uri.equals(uri) && known.kind.equals(kind)) grant = known;
        if (grant == null) {
            grant = new Grant();
            grant.id = UUID.randomUUID().toString();
            grant.kind = kind;
            grant.uri = uri;
            all.add(grant);
        }
        String name = "folder".equals(kind) ? displayName(DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri))) : displayName(uri);
        grant.name = name == null ? ("folder".equals(kind) ? "Folder" : "File") : name;
        grant.usedAt = System.currentTimeMillis();
        // The least recently used single files go once there are too many, and
        // their permission is given back to the system.
        List<Grant> files = new ArrayList<>();
        for (Grant known : all) if ("file".equals(known.kind)) files.add(known);
        Collections.sort(files, (a, b) -> Long.compare(a.usedAt, b.usedAt));
        for (int i = 0; i < files.size() - MAX_FILE_GRANTS; i += 1) {
            Grant old = files.get(i);
            all.remove(old);
            try {
                getContext().getContentResolver().releasePersistableUriPermission(old.uri, READ_WRITE);
            } catch (SecurityException alreadyGone) {
                // Nothing left to give back.
            }
        }
        save(all);
        return grant;
    }

    private synchronized void touch(Grant grant) {
        if (!grant.persisted) return;
        List<Grant> all = stored();
        for (Grant known : all) if (known.id.equals(grant.id)) known.usedAt = System.currentTimeMillis();
        save(all);
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private synchronized List<Grant> stored() {
        List<Grant> all = new ArrayList<>();
        try {
            JSONArray saved = new JSONArray(prefs().getString(KEY, "[]"));
            for (int i = 0; i < saved.length(); i += 1) {
                JSONObject item = saved.getJSONObject(i);
                Grant grant = new Grant();
                grant.id = item.getString("id");
                grant.kind = item.getString("kind");
                grant.name = item.getString("name");
                grant.uri = Uri.parse(item.getString("uri"));
                grant.usedAt = item.optLong("usedAt");
                all.add(grant);
            }
        } catch (JSONException unreadable) {
            // A list that can't be read is an empty list; the files themselves are untouched.
        }
        return all;
    }

    private synchronized void save(List<Grant> all) {
        JSONArray out = new JSONArray();
        try {
            for (Grant grant : all) {
                JSONObject item = new JSONObject();
                item.put("id", grant.id);
                item.put("kind", grant.kind);
                item.put("name", grant.name);
                item.put("uri", grant.uri.toString());
                item.put("usedAt", grant.usedAt);
                out.put(item);
            }
        } catch (JSONException impossible) {
            return;
        }
        prefs().edit().putString(KEY, out.toString()).apply();
    }

    private static JSObject json(Grant grant, boolean reachable) {
        JSObject out = new JSObject();
        out.put("id", grant.id);
        out.put("kind", grant.kind);
        out.put("name", grant.name);
        out.put("usedAt", grant.usedAt);
        out.put("reachable", reachable);
        out.put("persisted", grant.persisted);
        return out;
    }

    private static void reject(PluginCall call, Exception error) {
        if (error instanceof LocalFilesException) {
            call.reject(error.getMessage(), ((LocalFilesException) error).code);
        } else if (error instanceof SecurityException) {
            // The permission is gone, or the document is not under the granted folder.
            call.reject("Markie can't reach this any more.", "unreachable");
        } else {
            call.reject("That didn't work. Try again.", "failed");
        }
    }

    private static String sha256(byte[] bytes) {
        try {
            StringBuilder hex = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (Exception impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
