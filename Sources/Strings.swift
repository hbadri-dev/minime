import Foundation

/// Menu text in English, or Persian when that's the Mac's preferred language.
enum L10n {
    static let isPersian = (Locale.preferredLanguages.first ?? "en").hasPrefix("fa")

    private static let table: [String: (en: String, fa: String)] = [
        "cameraDenied": ("⚠️ Camera access is off — open Settings…", "⚠️ دسترسی دوربین داده نشده — باز کردن تنظیمات…"),
        "noCamera": ("⚠️ No camera found", "⚠️ دوربینی پیدا نشد"),
        "recordSplit": ("🎬 Record 10 s for Reels/TikTok (me + MiniMe)", "🎬 ضبط ویدیو ۱۰ ثانیه‌ای برای ریلز (من + MiniMe)"),
        "recordScene": ("🎬 Record 10 s (MiniMe only)", "🎬 ضبط ویدیو ۱۰ ثانیه‌ای (فقط MiniMe)"),
        "photo": ("📸 Photo (me + MiniMe)", "📸 عکس (من + MiniMe)"),
        "girl": ("👧 Girl", "👧 دختر"),
        "boy": ("👦 Boy", "👦 پسر"),
        "timeOfDay": ("Day & night", "روز و شب"),
        "todAuto": ("Automatic (follows the clock)", "خودکار (روز/شب با ساعت)"),
        "todDay": ("Always day ☀️", "همیشه روز ☀️"),
        "todNight": ("Always night 🌙", "همیشه شب 🌙"),
        "calibrate": ("🎯 Calibrate (look straight at the screen)", "🎯 کالیبره کن (مستقیم به صفحه نگاه کن)"),
        "mirror": ("Mirror mode", "حالت آینه‌ای"),
        "pause": ("Pause camera", "توقف دوربین"),
        "debug": ("Show camera & tracking points", "نمایش دوربین و نقاط ردیابی"),
        "login": ("Open at login", "اجرا هنگام ورود به مک"),
        "reload": ("Reload", "بارگذاری دوباره"),
        "quit": ("Quit MiniMe", "خروج"),
        "loginFailed": ("Couldn't change “Open at login”", "اجرا هنگام ورود فعال نشد"),
    ]

    static func tr(_ key: String) -> String {
        guard let e = table[key] else { return key }
        return isPersian ? e.fa : e.en
    }
}
