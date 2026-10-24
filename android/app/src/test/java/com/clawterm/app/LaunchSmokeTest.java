package com.clawterm.app;

import static org.junit.Assert.assertNotNull;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Cold start, end to end.
 *
 * The manifest theme is Theme.ClawTerm (a Theme.SplashScreen, i.e. a PLATFORM
 * theme) while MainActivity extends AppCompatActivity. Only
 * SplashScreen.installSplashScreen() swaps in postSplashScreenTheme before
 * setContentView; without it onCreate dies with "You need to use a
 * Theme.AppCompat theme" and the app closes instantly. This test is the guard
 * for that — it fails on the launch, not on some later screen.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class LaunchSmokeTest {
    @Test
    public void activityStarts() {
        MainActivity a = Robolectric.buildActivity(MainActivity.class).setup().get();
        assertNotNull(a);
        assertNotNull(a.findViewById(android.R.id.content));
    }
}
