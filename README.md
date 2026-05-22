# Twitch Watch History Extension

Eine private Browser-Extension für Chrome und Brave, die eine persönliche Twitch-Watch-History im Browser aufbaut.

Die Extension erkennt besuchte Twitch-Kanäle, zählt grob die aktive Watchtime und ergänzt die Twitch-Following-Seite um einen eigenen `History`-Tab. Dort werden zuletzt gesehene Kanäle als Karten angezeigt.

## Funktionen

- Trackt besuchte Twitch-Kanäle lokal im Browser.
- Zählt Watchtime, wenn der Twitch-Tab aktiv ist und das Fenster fokussiert ist.
- Zeigt zuletzt gesehene Kanäle auf einer eigenen History-Seite.
- Speichert pro Kanal u. a. Watchtime, Sessions, zuletzt gesehen, Streamtitel, Kategorien, Tags, Zuschauerzahl und Live-Status.
- Nutzt Vorschaubilder aus Twitch oder erzeugt eigene lokale Previews aus dem sichtbaren Stream.
- Kann Profilbilder, Live-Status, Zuschauerzahl, Tags und Kategorien über die Twitch API aktualisieren.
- Bietet Suche mit Syntax-Filtern wie `title:`, `game:`, `tag:`, `watch:>30m`, `sessions:>3`, `live:true` und `following:true`.
- Bietet Sortierung nach zuletzt gesehen, Watchtime, Sessions, Zuschauern, Live-Status, Following, Spiel, Streamtitel und Kanalname.
- Enthält ein Popup zum Verbinden mit Twitch, Aktualisieren des Live-Status und Löschen der History.

## Installation

1. Repository herunterladen oder klonen.
2. Chrome oder Brave öffnen.
3. `chrome://extensions` aufrufen.
4. Entwicklermodus aktivieren.
5. `Entpackte Erweiterung laden` anklicken.
6. Den Ordner `Stream History Extension` auswählen.

Nach Änderungen am Code muss die Extension auf `chrome://extensions` über den Aktualisieren-Button neu geladen werden. Bereits offene Twitch-Tabs sollten danach neu geladen werden.

## Nutzung

1. Einen Twitch-Kanal öffnen und im aktiven Tab laufen lassen.
2. Die Twitch-Following-Seite öffnen: `https://www.twitch.tv/directory/following`
3. Den neuen Tab `History` anklicken.
4. History durchsuchen, sortieren oder einzelne Kanäle wieder öffnen.

Die Extension fügt außerdem einen kleinen Popup-Button in der Browser-Leiste hinzu. Dort kann Twitch OAuth verbunden werden, damit API-Daten wie Live-Status, Zuschauerzahl und Profilbilder aktualisiert werden können.

## Twitch OAuth

Die Twitch Client-ID ist bereits in der Extension hinterlegt. Im Popup muss nur noch `Mit Twitch verbinden` angeklickt werden.

Die Redirect URL wird im Popup angezeigt und muss in der Twitch Developer Console für die verwendete App hinterlegt sein, falls OAuth noch nicht funktioniert.

## Disclaimer

Dieses Projekt ist ein privates Lern- und Hilfsprojekt und steht in keiner offiziellen Verbindung zu Twitch.

Code oder Inhalte wurden zur Vereinfachung des Workflows teilweise mit Unterstützung von KI erstellt.
