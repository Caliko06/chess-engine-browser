# README media

Every picture here is a real capture of the app or real measured data. Nothing is drawn or generated.

| File | `banner.png`, `social-preview.png` | `explore-*.webp` | `elo-gains-*.png` |
|---|---|---|---|
| What | One Explore capture with the title, set by `banner.html`; the social preview is 1280x640 for GitHub Settings > Social preview | The app at `just preview`, Chrome headless, 1440x900 at 2x, English UI | SPRT results per engine version, set by `elo-gains.html` |

Render again (from this folder):

```sh
for s in 1600,640:banner 1280,640:social-preview; do
  chrome-bot --headless=new --hide-scrollbars --force-device-scale-factor=1 --window-size=${s%%:*} \
    --screenshot=${s#*:}.png "file://$PWD/banner.html"
done
for m in light dark; do
  chrome-bot --headless=new --hide-scrollbars --force-device-scale-factor=2 --window-size=1000,600 \
    --screenshot=elo-gains-$m.png "file://$PWD/elo-gains.html#$m"
done
```
