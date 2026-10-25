package com.zvn.markie.mobile;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // The page scrolls inside its own screens and draws no scrollbar there
        // (src/styles.css). The web view's overlay bar would sit over the nav
        // bar's right edge, as iOS never shows one at rest either.
        WebView webView = getBridge().getWebView();
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
    }
}
