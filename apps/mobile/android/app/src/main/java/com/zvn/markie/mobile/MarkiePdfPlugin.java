package com.zvn.markie.mobile;

import android.annotation.SuppressLint;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.print.MarkiePdfWriter;
import android.print.PrintAttributes;
import android.view.View;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

/**
 * Prints a page of HTML to a PDF file, off screen (src/lib/export.ts).
 *
 * The page is loaded in a web view of its own that is never attached to a
 * window, so nobody sees it, and printed with the web view's own print
 * adapter: real pages, selectable text, the stylesheet's page breaks. The web
 * view is Chromium, the engine the desktop exports with, so the desktop's
 * page prints as it does there. The app's own web view is never touched.
 *
 * The caller gives the page size and margins in PDF points. The paper colour
 * it also sends is for iOS: here the page paints its own paper to the edge.
 *
 * Registered in MainActivity.
 */
@CapacitorPlugin(name = "MarkiePdf")
public class MarkiePdfPlugin extends Plugin {

    /** The whole job, and the wait for fonts and pictures inside it. */
    private static final long TIMEOUT_MS = 30_000;
    private static final long READY_TIMEOUT_MS = 8_000;
    /** CSS pixels per PDF point: 96 px to the inch against 72 pt. */
    private static final double PIXELS_PER_POINT = 96.0 / 72.0;
    /** True once the page, its fonts and its pictures have loaded. */
    private static final String READY_SCRIPT =
        "(function () { try { var f = document.fonts; return document.readyState === \"complete\" && (!f || f.status === \"loaded\")" +
        " && Array.prototype.every.call(document.images, function (i) { return i.complete; }); } catch (e) { return true; } })()";

    private final Handler main = new Handler(Looper.getMainLooper());
    /** One at a time: each job owns a web view. Read and written on the main thread. */
    private Job job;

    @PluginMethod
    public void render(final PluginCall call) {
        final String html = call.getString("html");
        final String path = call.getString("path");
        final Double width = call.getDouble("pageWidth");
        final Double height = call.getDouble("pageHeight");
        if (html == null || path == null || width == null || height == null || width < 72 || width > 2000 || height < 72 || height > 2000) {
            call.reject("The PDF request was incomplete.");
            return;
        }
        final double top = Math.max(0, call.getDouble("marginTop", 0.0));
        final double right = Math.max(0, call.getDouble("marginRight", 0.0));
        final double bottom = Math.max(0, call.getDouble("marginBottom", 0.0));
        final double left = Math.max(0, call.getDouble("marginLeft", 0.0));
        final File target = cacheFile(path);
        if (target == null || width - left - right < 36 || height - top - bottom < 36) {
            call.reject("The PDF request was incomplete.");
            return;
        }
        final PrintAttributes attributes = new PrintAttributes.Builder()
            .setMediaSize(new PrintAttributes.MediaSize("markie", "Markie", mils(width), mils(height)))
            .setResolution(new PrintAttributes.Resolution("markie", "Markie", 600, 600))
            .setMinMargins(new PrintAttributes.Margins(mils(left), mils(top), mils(right), mils(bottom)))
            .build();

        main.post(() -> {
            if (job != null) {
                call.reject("Markie is already making a PDF. Wait for that one to finish.");
                return;
            }
            job = new Job(call, html, target, attributes, (int) Math.round(width * PIXELS_PER_POINT), (int) Math.round(height * PIXELS_PER_POINT));
            job.start();
        });
    }

    /** Print sizes are in thousandths of an inch. */
    private static int mils(double points) {
        return (int) Math.round(points / 72.0 * 1000.0);
    }

    /** A file inside the app's cache folder and nowhere else. The cache is never backed up. */
    private File cacheFile(String path) {
        try {
            File cache = getContext().getCacheDir().getCanonicalFile();
            File target = new File(cache, path).getCanonicalFile();
            if (!target.getPath().startsWith(cache.getPath() + File.separator)) return null;
            if (!target.getName().toLowerCase().endsWith(".pdf")) return null;
            return target;
        } catch (Exception failure) {
            return null;
        }
    }

    private final class Job {

        private final PluginCall call;
        private final String html;
        private final File target;
        private final PrintAttributes attributes;
        private final int widthCss;
        private final int heightCss;
        private WebView webView;
        private boolean loaded;
        private boolean done;
        private long readyDeadline;

        Job(PluginCall call, String html, File target, PrintAttributes attributes, int widthCss, int heightCss) {
            this.call = call;
            this.html = html;
            this.target = target;
            this.attributes = attributes;
            this.widthCss = widthCss;
            this.heightCss = heightCss;
        }

        // Script is on for the desktop's fit script, which scales a wide table
        // to the column. The page is already sanitized: nothing a document
        // wrote runs (src/lib/markdown-html.ts), and a Live Doc's still copy
        // and a Word page carry a policy that allows no script at all.
        @SuppressLint("SetJavaScriptEnabled")
        void start() {
            try {
                webView = new WebView(getActivity());
                WebSettings settings = webView.getSettings();
                settings.setJavaScriptEnabled(true);
                settings.setAllowFileAccess(false);
                settings.setAllowContentAccess(false);
                settings.setDomStorageEnabled(false);
                settings.setSupportMultipleWindows(false);
                settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
                webView.setWebViewClient(
                    new WebViewClient() {
                        // The page is a document, not a site: nothing in it
                        // may take the web view anywhere.
                        @Override
                        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                            return true;
                        }

                        @Override
                        public void onPageFinished(WebView view, String url) {
                            if (loaded) return;
                            loaded = true;
                            readyDeadline = System.currentTimeMillis() + READY_TIMEOUT_MS;
                            waitUntilReady();
                        }
                    }
                );
                // The size of the paper, so anything the page measures before
                // printing (the fit script) is measured against the width it
                // will print at. Never attached to a window, so never drawn.
                float density = getContext().getResources().getDisplayMetrics().density;
                int widthPx = Math.round(widthCss * density);
                int heightPx = Math.round(heightCss * density);
                webView.measure(
                    View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(heightPx, View.MeasureSpec.EXACTLY)
                );
                webView.layout(0, 0, widthPx, heightPx);
                webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
                main.postDelayed(() -> finish("The PDF took too long and was stopped."), TIMEOUT_MS);
            } catch (Exception failure) {
                finish("The document couldn't be laid out for a PDF.");
            }
        }

        /** Fonts and pictures first. A picture that never arrives costs the wait, not the PDF. */
        private void waitUntilReady() {
            if (done || webView == null) return;
            webView.evaluateJavascript(READY_SCRIPT, (result) -> {
                if (done) return;
                boolean ready = "true".equals(result) || System.currentTimeMillis() >= readyDeadline;
                // One more beat when ready, for the page's own last layout pass.
                main.postDelayed(ready ? this::print : this::waitUntilReady, ready ? 250 : 100);
            });
        }

        private void print() {
            if (done || webView == null) return;
            try {
                File folder = target.getParentFile();
                if (folder != null && !folder.isDirectory() && !folder.mkdirs()) {
                    finish("The PDF couldn't be written.");
                    return;
                }
                MarkiePdfWriter.write(webView.createPrintDocumentAdapter(target.getName()), attributes, target, (error) -> main.post(() -> finish(error)));
            } catch (Exception failure) {
                finish("The document couldn't be laid out for a PDF.");
            }
        }

        /** Every way out comes through here once: the web view goes, then the answer. */
        private void finish(String error) {
            if (done) return;
            done = true;
            job = null;
            if (webView != null) {
                webView.stopLoading();
                webView.destroy();
                webView = null;
            }
            if (error != null) {
                // A half-written file is not an export.
                target.delete();
                call.reject(error);
                return;
            }
            JSObject result = new JSObject();
            result.put("uri", Uri.fromFile(target).toString());
            call.resolve(result);
        }
    }
}
