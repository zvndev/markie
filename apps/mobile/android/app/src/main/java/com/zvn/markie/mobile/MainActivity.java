package com.zvn.markie.mobile;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Files on this device, opened and saved in place. Registered before
        // the bridge starts, which is when it reads the list of plugins.
        registerPlugin(LocalFilesPlugin.class);
        // Before super.onCreate, which builds the bridge with the plugins known so far.
        registerPlugin(PushAvailabilityPlugin.class);
        // The app's own plugin: a document printed to a PDF file (MarkiePdfPlugin).
        registerPlugin(MarkiePdfPlugin.class);
        // The system font scale, for the page to apply itself (TextSizePlugin).
        registerPlugin(TextSizePlugin.class);
        super.onCreate(savedInstanceState);
        // The page scrolls inside its own screens and draws no scrollbar there
        // (src/styles.css). The web view's overlay bar would sit over the nav
        // bar's right edge, as iOS never shows one at rest either.
        WebView webView = getBridge().getWebView();
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        // Before the page draws: the web view's own text zoom is held to the
        // part the app's labels follow, and the page applies the rest.
        TextSizePlugin.pinZoom(webView, getResources().getConfiguration().fontScale);
    }
}
