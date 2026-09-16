# Add project specific ProGuard rules here.

# Keep Jackson model classes
-keep class isl.snudursopi.vending.api.** { *; }

# Keep Weimi SDK classes (when AARs are added)
-keep class com.weimi.** { *; }
