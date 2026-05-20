# Twitch Watch History

Private Manifest-V3-Extension fuer Chrome/Brave. Sie speichert lokal, welche Twitch-Kanaele du ab Installation besuchst und wie lange du sie aktiv anschaust.

## Datenschutz

- Keine Cloud.
- Kein externer Server.
- Keine Twitch-API und kein Twitch-Login.
- Keine rueckwirkenden Twitch-Daten.
- Speicherung nur in `chrome.storage.local`.
- Content Script laeuft nur auf `https://www.twitch.tv/*`.

## Dateien

- `manifest.json`: MV3-Konfiguration, Rechte, Content Script, Background Service Worker.
- `background.js`: erkennt aktive Twitch-Kanal-Tabs und zaehlt Watchtime.
- `content.js`: erkennt Twitch-SPA-Navigation, fuegt den History-Tab auf `/directory/following/...` ein und sammelt optionale Display-/Bilddaten aus bereits geladenem Twitch-DOM.
- `styles.css`: Twitch-aehnliches dunkles Styling fuer den History-Tab.
- `popup.html` / `popup.js`: kleines Popup zum Oeffnen, Aktualisieren und Loeschen.

## Lokal laden

1. Chrome oder Brave oeffnen.
2. `chrome://extensions` aufrufen.
3. Entwicklermodus aktivieren.
4. `Entpackte Erweiterung laden` anklicken.
5. Diesen Ordner auswaehlen: `Stream History Extension`.

Nach Code-Aenderungen auf `chrome://extensions` bei der Extension `Aktualisieren` klicken und Twitch-Tabs neu laden.

## Test-Checkliste

1. Einen Twitch-Kanal oeffnen, z. B. `https://www.twitch.tv/CHANNELNAME`.
2. Den Tab und das Browserfenster mindestens 30 Sekunden aktiv lassen.
3. Zu einem anderen Tab wechseln und ein paar Sekunden warten.
4. `https://www.twitch.tv/directory/following/channels` oeffnen.
5. Pruefen, dass die normale Twitch-Seite sichtbar bleibt und nur der neue Tab `History` ergaenzt wurde.
6. Den neuen Tab `History` anklicken. Die URL wechselt zu `/directory/following/history`.
7. Pruefen, ob Kanalname, Watchtime, zuletzt gesehen, Sessions und Link angezeigt werden.
8. Sortierung testen: zuletzt gesehen, laengste Watchtime, Kanalname.
9. Suchfeld testen.
10. `History loeschen` anklicken und pruefen, ob die Eintraege verschwinden.

## MVP-Grenzen

- Es werden nur echte Kanal-URLs im Format `https://www.twitch.tv/CHANNELNAME` gezaehlt.
- Interne Twitch-Seiten wie `/directory`, `/videos`, `/settings`, `/subscriptions`, `/drops`, `/inventory`, `/search`, `/p` und `/turbo` werden ignoriert.
- DisplayName wird aus besuchten Twitch-Seiten oder der Following-Seite ergaenzt. Profilbild und Kartenbild werden nur angezeigt, wenn sie eindeutig einer sichtbaren Following-Karte zugeordnet werden konnten.
- Pro Channel werden die letzten drei erkannten Twitch-Kategorien gespeichert und in der History als Filter angeboten. Kategorie-Wechsel werden ueber den Heartbeat erfasst, solange der Channel aktiv gezaehlt wird.
- Follow-Status, echtes Benachrichtigungs-Umschalten und Streamtitel sind bewusst nicht enthalten, weil Version 1 ohne Twitch-API arbeitet.
