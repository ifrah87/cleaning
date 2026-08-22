package so.orfanerealestate.cleaningtv;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Brings the board back after a power cut, without anyone finding the remote.
 *
 * READ THIS BEFORE BELIEVING IT WORKS
 * Android 10 and up restrict starting an activity from the background, and a boot
 * broadcast is background. Some televisions honour this launch, some drop it silently,
 * and the only way to know which kind the TCL is, is to pull the plug and watch. So
 * this is written as the cheap thing worth trying first, not as the guarantee.
 *
 * If the TV drops it, the reliable answer is to make this app the TV's HOME activity —
 * boot then lands here because there is nowhere else to land. That is a real cost: it
 * replaces the Google TV home screen, so nobody can use that set for anything else
 * again. Worth it for a dedicated board on the wall; not worth it for a TV that is
 * also watched. That is a decision about the room, not about the code, which is why
 * it is not switched on here.
 */
public class BootReceiver extends BroadcastReceiver {
  @Override public void onReceive(Context context, Intent intent) {
    Intent start = new Intent(context, MainActivity.class);
    // A receiver has no task of its own to start an activity into.
    start.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      context.startActivity(start);
    } catch (Exception ignored) {
      // Refused by a set that does not allow it. Nothing useful to do or say here —
      // the crew turns the TV on and taps the icon once, as before.
    }
  }
}
