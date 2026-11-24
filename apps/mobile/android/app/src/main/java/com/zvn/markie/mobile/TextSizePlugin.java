package com.zvn.markie.mobile;

import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The system's font scale, for the page (src/lib/text-size.ts).
 *
 * Left alone, a web view multiplies every piece of text by the font scale. At
 * the largest setting that is twice the size in bars and rows that were
 * drawn for one, and they clip. So the web view's own zoom is held to a small
 * range here, and the page is told the real scale: it gives all of it to what
 * a person reads and writes, and only this much to its own labels.
 */
@CapacitorPlugin(name = "MarkieTextSize")
public class TextSizePlugin extends Plugin {

    /** Keep in step with MAX_CHROME_SCALE and MIN_TEXT_SCALE in src/lib/text-size.ts. */
    static final float MAX_CHROME_SCALE = 1.15f;
    static final float MIN_SCALE = 0.85f;

    /** Holds the web view's whole-page text zoom to the part the app's own labels follow. */
    static void pinZoom(WebView webView, float fontScale) {
        float chrome = Math.max(MIN_SCALE, Math.min(MAX_CHROME_SCALE, fontScale));
        webView.getSettings().setTextZoom(Math.round(chrome * 100f));
    }

    private float fontScale() {
        float scale = getContext().getResources().getConfiguration().fontScale;
        return scale > 0f && !Float.isNaN(scale) ? scale : 1f;
    }

    @Override
    public void load() {
        pinZoom(getBridge().getWebView(), fontScale());
    }

    @Override
    protected void handleOnResume() {
        pinZoom(getBridge().getWebView(), fontScale());
    }

    @PluginMethod
    public void get(PluginCall call) {
        float scale = fontScale();
        // On the main thread, like every other touch of the web view's settings.
        getActivity().runOnUiThread(() -> pinZoom(getBridge().getWebView(), scale));
        JSObject result = new JSObject();
        result.put("scale", (double) scale);
        call.resolve(result);
    }
}
