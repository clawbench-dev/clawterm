# The JS bridge is reached by name from JavaScript, which R8 cannot see.
-keepclassmembers class com.clawterm.app.NativeBridge {
    public *;
}
-keep class com.clawterm.app.NativeBridge { *; }

# Keep the activity entry point (referenced only from the manifest).
-keep class com.clawterm.app.MainActivity { *; }
