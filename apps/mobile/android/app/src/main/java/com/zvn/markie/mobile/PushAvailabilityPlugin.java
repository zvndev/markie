package com.zvn.markie.mobile;

import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tells the page whether this build can receive push notifications.
 *
 * Capacitor's push plugin asks Firebase for a token in register(), and
 * Firebase throws when the app was built without a Firebase project
 * (android/app/google-services.json, which is not in the repo). The page asks
 * here first and never calls register() on a build that has none
 * (src/lib/push.ts).
 *
 * The google-services Gradle plugin turns that file into string resources,
 * google_app_id among them, so the resource being there is the file having
 * been there at build time. Looking it up by name keeps Firebase's own
 * classes out of this file: nothing here calls into Firebase at all.
 */
@CapacitorPlugin(name = "MarkiePush")
public class PushAvailabilityPlugin extends Plugin {

    @PluginMethod
    public void available(PluginCall call) {
        Context context = getContext();
        int id = context.getResources().getIdentifier("google_app_id", "string", context.getPackageName());
        JSObject result = new JSObject();
        result.put("available", id != 0);
        call.resolve(result);
    }
}
