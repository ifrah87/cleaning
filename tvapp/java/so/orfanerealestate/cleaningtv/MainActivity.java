package so.orfanerealestate.cleaningtv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.Calendar;

/**
 * The whole app: a television pointed at the board, permanently.
 *
 * THE ONE PROBLEM THIS EXISTS TO SOLVE
 * The board has always been openable on the TV — it is a URL, any browser can show it.
 * What no browser does is STAY shown. It sleeps, it screensavers, it forgets the page
 * after a power cut, and it keeps whatever copy of the app it loaded in March. The
 * screen nobody touches is the screen that goes quietly wrong, and this file is four
 * answers to that: keep awake, come back after a cut, reload the code once a day, and
 * retry rather than sit on an error page.
 */
public class MainActivity extends Activity {

  /** The board, told it is the board. src=tvapp is only there to be greppable later. */
  private static final String BOARD_URL =
      "https://cleaning.orfanerealestate.so/?tv=1&src=tvapp";

  /**
   * A failed load retries on this cadence, forever. Forever is deliberate: the office
   * hotspot goes down for hours, and the correct behaviour is to be showing the board
   * again the moment it returns, with nobody having been told anything.
   */
  private static final long RETRY_MS = 15_000L;

  /**
   * Reload if the app comes back to the foreground having been away this long. The
   * page syncs itself live, so this is not about data — it is about picking up newly
   * shipped code on a screen that would otherwise run one build until someone noticed.
   */
  private static final long STALE_MS = 30 * 60 * 1000L;

  /** Just past the app's own 3am work-day cutoff, so the reload lands in the new day. */
  private static final int RELOAD_HOUR = 3, RELOAD_MINUTE = 5;

  private WebView web;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private boolean failed = false;
  private long leftAt = 0L;

  private final Runnable retry = new Runnable() {
    @Override public void run() { if (failed) load(); }
  };

  /**
   * The daily reload. It reschedules itself from inside rather than repeating on a
   * fixed interval, because a 24h repeat started at 14:00 fires at 14:00 forever —
   * the point is the wall clock, not the elapsed time.
   */
  private final Runnable nightly = new Runnable() {
    @Override public void run() { load(); scheduleNightly(); }
  };

  @SuppressLint("SetJavaScriptEnabled")
  @Override protected void onCreate(Bundle saved) {
    super.onCreate(saved);

    // A display, not a session. Without this the TV screensavers over the board and
    // the crew walks past a photo of a mountain.
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);

    web = new WebView(this);
    setContentView(web);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    // The board keeps its own copy of the day in localStorage and runs from it when
    // the server refuses. Without DOM storage the offline path is not merely degraded,
    // it is gone.
    s.setDomStorageEnabled(true);
    s.setLoadsImagesAutomatically(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    // Network-first, matching sw.js. The service worker is the thing that decides what
    // is cached; the WebView should not be quietly holding a second opinion.
    s.setCacheMode(WebSettings.LOAD_DEFAULT);
    s.setSupportZoom(false);
    s.setBuiltInZoomControls(false);

    web.setBackgroundColor(0xFF0B1220);          // board ground, so no white flash
    web.setVerticalScrollBarEnabled(false);
    web.setHorizontalScrollBarEnabled(false);
    web.setOverScrollMode(View.OVER_SCROLL_NEVER);
    // The board itself is read-only, which is what tempted an earlier version of this
    // file to make the WebView unfocusable. That was wrong: the app asks for a PIN
    // before it will show anything, and a view that cannot take focus can never focus
    // the PIN field, so Android never raises the on-screen keyboard and the TV sits on
    // a login it is physically incapable of completing. Focusable it is.
    web.setFocusable(true);
    web.setFocusableInTouchMode(true);
    web.requestFocus();

    // Lets the board be inspected from a laptop over adb at chrome://inspect. This is
    // an internal sideloaded app on an office TV, and being able to see the console on
    // the one screen nobody stands in front of is worth more than the hardening.
    if (Build.VERSION.SDK_INT >= 19) WebView.setWebContentsDebuggingEnabled(true);

    web.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
        return false;                             // one origin, one page; never leave
      }
      @Override public void onPageFinished(WebView v, String url) {
        failed = false;
        handler.removeCallbacks(retry);
      }
      @Override public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
        // Only the page itself failing is a failure. A missing icon is not a reason to
        // throw the whole board away and start reloading it every 15 seconds.
        if (Build.VERSION.SDK_INT >= 21 && !req.isForMainFrame()) return;
        scheduleRetry();
      }
      @SuppressWarnings("deprecation")
      @Override public void onReceivedError(WebView v, int code, String desc, String url) {
        scheduleRetry();
      }
    });

    watchNetwork();
    scheduleNightly();
    load();
  }

  private void load() {
    failed = false;
    handler.removeCallbacks(retry);
    web.loadUrl(BOARD_URL);
  }

  private void scheduleRetry() {
    failed = true;
    handler.removeCallbacks(retry);
    handler.postDelayed(retry, RETRY_MS);
  }

  /** Milliseconds from now until the next 03:05 on the TV's own clock. */
  private void scheduleNightly() {
    Calendar next = Calendar.getInstance();
    next.set(Calendar.HOUR_OF_DAY, RELOAD_HOUR);
    next.set(Calendar.MINUTE, RELOAD_MINUTE);
    next.set(Calendar.SECOND, 0);
    next.set(Calendar.MILLISECOND, 0);
    if (next.getTimeInMillis() <= System.currentTimeMillis()) next.add(Calendar.DATE, 1);
    handler.removeCallbacks(nightly);
    handler.postDelayed(nightly, next.getTimeInMillis() - System.currentTimeMillis());
  }

  /**
   * Come straight back when the hotspot does, instead of waiting out the retry timer.
   * The difference is only ever seconds, but they are the seconds somebody is standing
   * in front of the screen wondering whether the thing is broken.
   */
  private void watchNetwork() {
    if (Build.VERSION.SDK_INT < 24) return;
    ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
    if (cm == null) return;
    try {
      cm.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network n) {
          handler.post(new Runnable() {
            @Override public void run() { if (failed) load(); }
          });
        }
      });
    } catch (SecurityException ignored) {
      // Some sets refuse the callback. The retry timer already covers this case.
    }
  }

  /**
   * Kiosk means the remote cannot get out. Back would drop the crew onto a blank
   * activity and Home is the TV's own business, not ours — so Back is swallowed and
   * everything else is handed to the page.
   */
  @Override public boolean onKeyDown(int code, KeyEvent e) {
    if (code == KeyEvent.KEYCODE_BACK) return true;
    return super.onKeyDown(code, e);
  }

  @Override protected void onResume() {
    super.onResume();
    immersive();
    if (leftAt > 0 && SystemClock.elapsedRealtime() - leftAt > STALE_MS) load();
    leftAt = 0;
  }

  @Override protected void onPause() {
    super.onPause();
    leftAt = SystemClock.elapsedRealtime();
  }

  @Override public void onWindowFocusChanged(boolean has) {
    super.onWindowFocusChanged(has);
    if (has) immersive();
  }

  /** No status bar, no navigation bar, no clock over the board. */
  @SuppressWarnings("deprecation")
  private void immersive() {
    web.setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
      | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
      | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
      | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
      | View.SYSTEM_UI_FLAG_FULLSCREEN
      | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
  }

  @Override protected void onDestroy() {
    handler.removeCallbacksAndMessages(null);
    if (web != null) web.destroy();
    super.onDestroy();
  }
}
