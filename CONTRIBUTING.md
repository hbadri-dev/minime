# Contributing to MiniMe

Thanks for wanting to make MiniMe better! 🧸

- **Bugs / ideas:** open an issue. For tracking problems, turn on *Show camera & tracking points* in the menu and
  attach `~/Library/Caches/com.minime.wallpaper/web.log` (it contains numbers only, no images).
- **Code:** `./build.sh --install` builds and runs your changes. For web-only changes, point the app at your checkout
  with `defaults write com.minime.wallpaper webDir "$PWD/web"` and use *Reload* in the menu.
- **Art:** keep the same soft kawaii picture-book style. New characters need a faceless head and an armless body on a
  transparent background; run `python3 tools/process_assets.py` after adding them to `art/raw/`.
- Please never commit photos or videos of real people.
