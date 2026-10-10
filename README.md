# ioBroker.etatouch

ioBroker-Adapter für ETA-Heizungen mit ETAtouch-Bedienung. Er nutzt die **ETAtouch RESTful Webservices** (Port 8080) und legt alle Datenpunkte aus dem Menübaum der Heizung als Objekte im ioBroker an.

## Voraussetzungen

- ETAtouch mit Systemsoftware ≥ 1.20 (für `varinfo` ≥ 1.49 empfohlen)
- Heizung bei [meineta.at](https://www.meineta.at) registriert, **LAN-Zugriff beantragt** und an der Heizung in den Systemeinstellungen **aktiviert**
- ioBroker mit js-controller ≥ 5, Admin ≥ 6, Node.js ≥ 20

## Installation (von GitHub)

1. ioBroker Admin → **Adapter** → Expertenmodus aktivieren → Symbol **„Installieren aus eigener URL“** (Katze/GitHub)
2. Reiter „Beliebig“ / „Custom“ → URL eintragen: `https://github.com/jakobhauber/ioBroker.etatouch`
3. Installieren, danach eine Instanz anlegen.

## Einrichtung

1. Instanz-Einstellungen öffnen, **IP-Adresse** der Heizung eintragen (Port normalerweise 8080), Abfrageintervall wählen, **Speichern**.
2. Warten bis die Instanz läuft (grün), dann **„XML-Struktur einlesen“** drücken.
   - Die Menüstruktur ist bei jeder Heizung anders, daher werden die Objekte erst auf Knopfdruck angelegt.
   - Der Vorgang dauert je nach Anlage 10–15 Minuten (für jede Variable wird die Beschreibung von der Heizung abgefragt; bei ca. 1800 Einträgen getestet: ~12 Minuten). Er läuft im Hintergrund, der Fortschritt steht im Log und in `etatouch.0.info.structureStatus`. Währenddessen die Instanz nicht neu starten bzw. keine Einstellungen speichern.
3. Danach erscheinen die Objekte unter `etatouch.0.<Funktionsblock>...` (z.B. `etatouch.0.Kessel...`, `etatouch.0.PufferHof...`).

Den Button kann man jederzeit erneut drücken, z.B. nach einem Software-Update der Heizung. Neue Datenpunkte werden angelegt, nicht mehr vorhandene entfernt.

## Funktionsweise

- Der Adapter legt auf der Heizung ein Variablen-Set (`/user/vars/ioBroker`) mit allen Datenpunkten an und liest pro Zyklus alle Werte mit **einer** Anfrage. Nach einem Neustart der Heizung wird das Set automatisch neu angelegt.
- Werte:
  - Zahlen werden skaliert (z.B. `60.5` °C) mit Einheit, Min/Max.
  - Textwerte (z.B. Ein/Aus) als Zahl mit Auswahlliste (`common.states`).
  - Zeitfenster als Text (`06:00 - 12:00`), sonstiges als Text.
- Menüpunkte mit Unterpunkten, die selbst einen Wert haben, bekommen einen State `_Wert`.
- `info.connection` – Verbindung zur Heizung
- `info.errors` – aktive Meldungen der Heizung als JSON, `info.errorCount` – Anzahl

## Schreiben

Standardmäßig **aus**. Mit „Schreiben erlauben“ werden alle Datenpunkte schreibbar, die laut Heizung veränderbar sind:

- Zahlen: Wert in der angezeigten Einheit (z.B. `55` für 55 °C)
- Textwerte: Zahl aus der Auswahlliste
- Zeitfenster: `HH:MM - HH:MM` oder `HH:MM - HH:MM Wert` (Zeiten in 15-Minuten-Schritten)

Nach dem Schreiben wird der Wert sofort neu von der Heizung gelesen.

## Hinweis: „Invalid permission“

Bei Anlagen mit mehreren CAN-Knoten kann die Heizung den Zugriff auf einzelne Knoten verweigern (Antwort `Invalid permission`), zeitweise fehlen diese Funktionsblöcke auch im Menü. Solche Datenpunkte werden beim Einlesen übersprungen (Warnung im Log). Wurden sie früher schon einmal erfolgreich eingelesen, bleiben die Objekte erhalten und der Adapter versucht stündlich, sie wieder abzufragen. Ist der Knoten wieder erreichbar, einfach erneut „XML-Struktur einlesen“ drücken.

## Changelog

### 0.1.1
- Datenpunkte ohne Zugriff (Invalid permission) werden übersprungen statt leer angelegt
- Wiederholung bei Timeouts, stündlicher Neuversuch für nicht abrufbare Variablen

### 0.1.0
- Erste Version

## License

MIT License, Copyright (c) 2026 Jakob Hauber
