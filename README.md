# Twitch Watched History Extension

Eine private Browser-Extension fuer Chrome und Brave, die lokal eine persoenliche Twitch-Watch-History aufbaut.

Die Extension fuegt auf der Twitch-Following-Seite einen eigenen Tab `History` hinzu. Dort werden Twitch-Kanaele angezeigt, die du ab Installation der Extension besucht hast, inklusive grober Watchtime, letzter Aktivitaet, Session-Anzahl und zuletzt erkannter Kategorien.

## Ziel

Twitch bietet keine einfache private Watch-History fuer besuchte Kanaele. Dieses Projekt soll diese Luecke lokal im Browser schliessen:

- keine Cloud
- kein externer Server
- keine Twitch-API
- kein Twitch-Login ueber die Extension
- keine rueckwirkende Auswertung alter Twitch-Daten
- Speicherung nur lokal ueber `chrome.storage.local`

## Features

- Erkennt echte Twitch-Kanal-Seiten wie `https://www.twitch.tv/CHANNELNAME`.
- Ignoriert interne Twitch-Seiten wie `/directory`, `/videos`, `/settings`, `/subscriptions`, `/drops`, `/inventory`, `/search`, `/p` und `/turbo`.
- Zaehlt Watchtime nur, wenn:
  - der Tab aktiv ist
  - das Browserfenster fokussiert ist
  - die aktuelle URL eine Twitch-Kanal-Seite ist
- Speichert pro Channel:
  - Channel-Name
  - Display-Name, sofern lokal erkennbar
  - erstes Auftreten
  - zuletzt gesehen
  - gesamte Watchtime
  - Session-Anzahl
  - letzte URL
  - optionale Profil-/Bannerbilder, sofern eindeutig lokal zuordenbar
  - letzte drei erkannte Twitch-Kategorien
- Fuegt auf `https://www.twitch.tv/directory/following/...` einen `History`-Tab hinzu.
- Oeffnet eine lokale virtuelle History-Seite unter `/directory/following/history`.
- Bietet Suche, Sortierung und Kategorie-Filter.
- Hat ein kleines Popup zum Oeffnen der Following-Seite und Loeschen der lokalen History.

## History-Ansicht

Die History-Seite zeigt Karten fuer besuchte Kanaele. Jede Karte enthaelt:

- Kanalname bzw. Display-Name
- grobe Watchtime
- Zeitpunkt, wann der Kanal zuletzt gesehen wurde
- Session-Anzahl
- zuletzt erkannte Kategorien
- Link zum Kanal

Sortierung:

- zuletzt gesehen
- laengste Watchtime
- Kanalname

Filter:

- Suchfeld fuer Kanalname/Display-Name
- Kategorie-Filter auf Basis der zuletzt erkannten Kategorien
- Button zum Loeschen der lokalen History

## Kategorie-Tracking

Die Extension versucht auf Channel-Seiten den sichtbaren Twitch-Kategorie-Link zu erkennen, zum Beispiel `Apex Legends`, `VALORANT` oder `Just Chatting`.

Diese Information wird regelmaessig ueber den Heartbeat aktualisiert. Wenn ein Stream waehrend einer laengeren Watch-Session die Kategorie wechselt, kann die Extension diese Aenderung erfassen. Pro Channel werden maximal die letzten drei Kategorien gespeichert.

Da keine Twitch-API genutzt wird, basiert die Erkennung auf dem aktuell sichtbaren Twitch-DOM und ist als pragmatischer Richtwert gedacht.

## Datenschutz

Diese Extension ist fuer private lokale Nutzung gebaut.

- Es werden keine Daten an einen eigenen Server gesendet.
- Es gibt keine Cloud-Synchronisierung.
- Es gibt keine Twitch-API-Anfragen.
- Es wird kein Twitch-OAuth oder Twitch-Login genutzt.
- Es werden keine alten Twitch-Daten rueckwirkend ausgelesen.
- Die Daten liegen lokal in `chrome.storage.local`.
- Das Content Script laeuft nur auf `https://www.twitch.tv/*`.

Normale Netzwerkrequests von Twitch selbst bleiben natuerlich Teil der regulaeren Twitch-Nutzung im Browser.

## Installation in Chrome oder Brave

1. Repository herunterladen oder klonen.
2. Chrome oder Brave oeffnen.
3. `chrome://extensions` aufrufen.
4. Entwicklermodus aktivieren.
5. `Entpackte Erweiterung laden` anklicken.
6. Den Ordner `Stream History Extension` auswaehlen.

Nach Code-Aenderungen:

1. `chrome://extensions` oeffnen.
2. Bei der Extension auf `Aktualisieren` klicken.
3. Bereits offene Twitch-Tabs neu laden.

## Nutzung

1. Einen Twitch-Kanal oeffnen, z. B. `https://www.twitch.tv/CHANNELNAME`.
2. Den Tab aktiv ansehen oder im aktiven Fenster laufen lassen.
3. Die Extension zaehlt grob die aktive Watchtime.
4. `https://www.twitch.tv/directory/following/channels` oeffnen.
5. Den neuen Tab `History` anklicken.
6. History durchsuchen, sortieren oder nach Kategorie filtern.

## Test-Checkliste

- Twitch-Kanal oeffnen.
- 30 Sekunden im aktiven Tab laufen lassen.
- Tab wechseln und pruefen, ob Watchtime gespeichert wurde.
- Following-Seite oeffnen.
- Pruefen, ob der Tab `History` vorhanden ist.
- History-Tab oeffnen.
- Suche testen.
- Sortierung testen.
- Kategorie-Filter testen, nachdem Kategorien gesammelt wurden.
- `History loeschen` testen.

## Dateistruktur

```text
Stream History Extension/
  manifest.json
  background.js
  content.js
  styles.css
  popup.html
  popup.js
  README.md
```

## Wichtige Dateien

- `manifest.json`: Manifest-V3-Konfiguration, Berechtigungen, Content Script, Service Worker und Popup.
- `background.js`: zentrale Tracking-Logik fuer aktive Tabs, Fensterfokus, Watchtime, Sessions und lokale Speicherung.
- `content.js`: Twitch-SPA-Erkennung, Einfuegen des History-Tabs, History-UI, Kategorie-Erkennung und DOM-basierte Metadaten.
- `styles.css`: dunkles Twitch-aehnliches Styling fuer History-Tab, Karten, Toolbar und Filter.
- `popup.html` / `popup.js`: kleines Browser-Action-Popup.

## Technische Hinweise

Twitch ist eine React-Single-Page-App. Deshalb:

- beobachtet die Extension DOM-Aenderungen mit `MutationObserver`
- erkennt URL-Wechsel ueber gepatchte History-Methoden
- fuegt den History-Tab defensiv ein, ohne sich zu stark auf Twitch-CSS-Klassen zu verlassen
- rendert die History als eigenes lokales Panel auf einer virtuellen Route

Die Watchtime wird im Background-Service-Worker verwaltet, weil dort Tab-Aktivitaet und Fensterfokus sauberer geprueft werden koennen.

## Grenzen

Dies ist eine MVP-Version.

- Watchtime ist ein grober Richtwert, keine sekundengenaue Statistik.
- Bilder werden nur angezeigt, wenn sie lokal eindeutig einer sichtbaren Twitch-Karte zugeordnet werden konnten.
- Kategorie-Erkennung basiert auf sichtbaren Twitch-DOM-Links und kann durch Twitch-Layout-Aenderungen beeinflusst werden.
- Kein Following-Filter in Version 1.
- Kein echter Follow-/Benachrichtigungsstatus.
- Keine Streamtitel-Erfassung.
- Keine Rueckwirkende Historie vor Installation.
- Keine Synchronisierung zwischen Browsern oder Geraeten.

## Geplante oder moegliche Erweiterungen

- stabilere Thumbnail- und Profilbild-Erfassung
- optionaler Twitch-API-Modus
- Streamtitel speichern
- Kategorie-Watchtime separat auswerten
- Export/Import der lokalen History
- bessere Statistikansichten
- optionaler Following-Filter

## Disclaimer

Dieses Projekt ist ein privates Lern- und Hilfsprojekt und steht in keiner offiziellen Verbindung zu Twitch.

Code oder Inhalte wurden zur Vereinfachung des Workflows teilweise mit Unterstuetzung von KI erstellt.
