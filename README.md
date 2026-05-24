# Twitch Watch History Extension

Private Chrome/Brave-Extension, die lokal eine Watch-History fuer Twitch-Kanaele aufbaut.

## Funktion

- Erkennt besuchte Twitch-Kanäle und speichert sie lokal im Browser.
- Zaehlt grob Watchtime und Sessions, solange der Twitch-Tab aktiv ist.
- Ergänzt die Twitch-Following-Seite um einen eigenen `History`-Tab.
- Zeigt gespeicherte Kanaele mit Suche, Sortierung, Streamdaten und Vorschaubildern.
- Bietet Export, Import und Auto-Backup der lokalen History.

## Installation

1. Repository herunterladen oder klonen.
2. Chrome oder Brave öffnen.
3. `chrome://extensions` aufrufen.
4. Entwicklermodus aktivieren.
5. `Entpackte Erweiterung laden` anklicken.
6. Den Ordner `Stream History Extension` auswaehlen.

Nach Code-Aenderungen muss die Extension auf `chrome://extensions` neu geladen werden.

## Nutzung

1. Einen Twitch-Kanal oeffnen und im aktiven Tab schauen.
2. `https://www.twitch.tv/directory/following` oeffnen.
3. Den neuen Tab `History` anklicken.
4. History durchsuchen, sortieren oder Kanaele erneut oeffnen.

Das Popup zeigt eine kurze Zusammenfassung und fuehrt zur Einstellungsseite.

## Twitch OAuth

OAuth ist optional, wird aber für genauere Twitch-API-Daten genutzt: Live-Status, Zuschauerzahlen, Profilbilder und aktuelle Stream-Metadaten.

Die Redirect URL wird in den Einstellungen angezeigt und muss in der Twitch Developer Console fuer die verwendete App hinterlegt sein.

## Disclaimer

Dieses Projekt ist ein privates Lern- und Hilfsprojekt und steht in keiner offiziellen Verbindung zu Twitch.

Code oder Inhalte wurden teilweise mit Unterstuetzung von KI erstellt.
