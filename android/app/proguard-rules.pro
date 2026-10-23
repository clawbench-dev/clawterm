# The JS bridge is reached by NAME from JavaScript, which R8 cannot see.
-keepclassmembers class com.clawterm.app.MainActivity$NativeInterface {
    public *;
}
-keep class com.clawterm.app.MainActivity$NativeInterface { *; }

# Entry point referenced only from the manifest.
-keep class com.clawterm.app.MainActivity { *; }

# JSch is reflection-heavy (algorithm factories, key implementations).
-keep class com.jcraft.jsch.** { *; }
-dontwarn com.jcraft.jsch.**

# org.json is provided by the platform; keep the bridge's use of it intact.
-keep class org.json.** { *; }
