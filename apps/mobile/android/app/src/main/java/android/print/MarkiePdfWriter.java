package android.print;

import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import java.io.File;

/**
 * Runs a print adapter straight to a PDF file, with no print dialog.
 *
 * This class is in the android.print package on purpose, and it is the only
 * reason there is a second file: the two callback classes a print adapter
 * reports to (LayoutResultCallback, WriteResultCallback) have constructors
 * only code in this package can call. Everything else about making a PDF is
 * in com.zvn.markie.mobile.MarkiePdfPlugin.
 */
public final class MarkiePdfWriter {

    public interface Done {
        /** Null when the file was written. */
        void onDone(String error);
    }

    private MarkiePdfWriter() {}

    public static void write(final PrintDocumentAdapter adapter, PrintAttributes attributes, final File target, final Done done) {
        final CancellationSignal signal = new CancellationSignal();
        adapter.onStart();
        adapter.onLayout(
            null,
            attributes,
            signal,
            new PrintDocumentAdapter.LayoutResultCallback() {
                @Override
                public void onLayoutFinished(PrintDocumentInfo info, boolean changed) {
                    final ParcelFileDescriptor file;
                    try {
                        file = ParcelFileDescriptor.open(
                            target,
                            ParcelFileDescriptor.MODE_CREATE | ParcelFileDescriptor.MODE_TRUNCATE | ParcelFileDescriptor.MODE_READ_WRITE
                        );
                    } catch (Exception failure) {
                        finish(adapter, null, done, "The PDF couldn't be written.");
                        return;
                    }
                    adapter.onWrite(
                        new PageRange[] { PageRange.ALL_PAGES },
                        file,
                        signal,
                        new PrintDocumentAdapter.WriteResultCallback() {
                            @Override
                            public void onWriteFinished(PageRange[] pages) {
                                finish(adapter, file, done, null);
                            }

                            @Override
                            public void onWriteFailed(CharSequence error) {
                                finish(adapter, file, done, "The document couldn't be laid out for a PDF.");
                            }

                            @Override
                            public void onWriteCancelled() {
                                finish(adapter, file, done, "The PDF was stopped.");
                            }
                        }
                    );
                }

                @Override
                public void onLayoutFailed(CharSequence error) {
                    finish(adapter, null, done, "The document couldn't be laid out for a PDF.");
                }

                @Override
                public void onLayoutCancelled() {
                    finish(adapter, null, done, "The PDF was stopped.");
                }
            },
            null
        );
    }

    private static void finish(PrintDocumentAdapter adapter, ParcelFileDescriptor file, Done done, String error) {
        try {
            if (file != null) file.close();
        } catch (Exception ignored) {
            // The answer below is what matters.
        }
        try {
            adapter.onFinish();
        } catch (Exception ignored) {
            // Already finished.
        }
        done.onDone(error);
    }
}
