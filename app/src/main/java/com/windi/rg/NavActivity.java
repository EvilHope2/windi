package com.windi.rg;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/**
 * Small bridge activity to reliably open Google Maps navigation from a TWA.
 *
 * We trigger this via a custom scheme link from the web layer:
 *   windi-nav://navigate?dest=<lat>,<lng>
 *
 * Then we launch the native Google Maps navigation intent and finish.
 */
public class NavActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Uri data = getIntent() != null ? getIntent().getData() : null;
        String dest = data != null ? data.getQueryParameter("dest") : null;

        if (dest != null && !dest.trim().isEmpty()) {
            // Use Google Maps navigation mode (turn-by-turn + voice).
            // Example: google.navigation:q=-53.787,-67.7095&mode=d
            Uri navUri = Uri.parse("google.navigation:q=" + Uri.encode(dest) + "&mode=d");
            Intent i = new Intent(Intent.ACTION_VIEW, navUri);
            i.setPackage("com.google.android.apps.maps");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                startActivity(i);
            } catch (Exception ignored) {
                // Fall back to a normal https URL if Maps can't handle it.
                Uri web = Uri.parse("https://www.google.com/maps/dir/?api=1&destination=" + Uri.encode(dest)
                        + "&travelmode=driving&dir_action=navigate");
                Intent w = new Intent(Intent.ACTION_VIEW, web);
                w.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try { startActivity(w); } catch (Exception ignored2) { }
            }
        }

        finish();
    }
}

