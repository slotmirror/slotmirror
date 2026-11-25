---
title: Outlook und Google Kalender synchronisieren
description: Zeige deine Outlook-Termine im Google Kalender und deine Google-Termine in Outlook, als belegte Blöcke oder mit Titel, ohne Sync-Dienst.
sidebar:
  order: 1
---

Du hast einen Outlook-Kalender für die Arbeit und einen Google Kalender für alles andere. Wer dich
in einem Kalender bucht, sieht den anderen nicht. Mit dieser Anleitung zeigt jeder Kalender die
Termine des anderen.

## Warum ein Kalender-Abo nicht reicht

Outlook und Google Kalender können einen Kalender über seine Adresse abonnieren, einen ICS-Link. Du
siehst den anderen Kalender dann neben deinem. Ein Abo hat drei Grenzen:

- Es ist schreibgeschützt und geht nur in eine Richtung.
- Die Kalender-App aktualisiert es nach eigenem Zeitplan. Eine Änderung kann Stunden oder länger
  brauchen.
- Wer nachsieht, wann du frei bist, sieht deinen Hauptkalender. Die Termine eines abonnierten
  Kalenders erscheinen dort nicht.

slotmirror schreibt echte Termine in den Hauptkalender jedes Kontos. Wer nachsieht, wann du frei
bist, sieht dann die Blöcke. Mit `PUBLIC_URL` startet eine Änderung die Synchronisation, sobald der
Anbieter sie meldet. Ohne `PUBLIC_URL` kommt die Änderung beim nächsten Lauf an, nach höchstens
10 Minuten.

## Was du bekommst

- Arbeitstermine erscheinen im Google Kalender, auf Wunsch mit Titel.
- Google-Termine erscheinen in Outlook als private Termine.
- Ein verschobener oder abgesagter Termin verschiebt oder entfernt seine Kopie.

## Schritte

1. Richte slotmirror mit dem [Quickstart](../../../docs/quickstart/) ein.
2. Lege eine [Microsoft-Entra-App](../../../docs/entra-setup/) und einen
   [Google-OAuth-Client](../../../docs/google-setup/) an.
3. Setze `PUBLIC_URL`, damit die Anbieter deine Installation über Änderungen informieren.
4. Melde dich an und verbinde beide Konten auf der Seite **Kalender** mit **Kalender verbinden**.
5. Wähle auf der Seite **Spiegelung** **Alle als belegt spiegeln**: Beide Kalender zeigen dann die
   Termine des anderen als belegt.
6. Öffne die Zeile vom Outlook-Kalender zum Google Kalender. Wähle unter **Was kopiert wird**
   **Titel** oder **Alles** und stelle **Was andere sehen** auf **Wie bei dir**. Die Vorschau zeigt
   das Ergebnis.
7. Wähle **Speichern**.

## Gut zu wissen

- Kopien landen im Hauptkalender jedes Kontos.
- Termine, die in der Quelle als privat markiert sind, tragen nie mehr als „Belegt“.
- Ganztägige Termine wie Feiertage werden standardmäßig gespiegelt und blocken den ganzen Tag.
  Termine, die als frei markiert sind, bleiben draußen. Um alle ganztägigen Termine auszulassen,
  schalte **Ganztägige Termine überspringen** unter **Für alle Spiegelungen** auf der Seite
  **Spiegelung** ein.

## Fragen

### Funktioniert das mit Outlook.com und Gmail?

Ja. Auf der Microsoft-Seite verbindet slotmirror Geschäfts- und Schulkonten von Microsoft 365 und
persönliche Microsoft-Konten wie Outlook.com. Persönliche Konten brauchen in der
[Entra-App](../../../docs/entra-setup/) den Kontotyp **Accounts in any organizational directory and
personal Microsoft accounts**. Auf der Google-Seite verbindet es Google-Konten.

### Sieht der Google Kalender die Titel meiner Outlook-Termine?

Standardmäßig nicht. Auf der Stufe **Nur belegt** trägt eine Kopie nur den Titel aus **Titel
der Kopien bei „Nur belegt“**, standardmäßig „Belegt“. Titel, Ort und Teilnehmende des Termins bleiben draußen.
**Titel** fügt den Titel hinzu, **Alles** weitere Details. Du wählst die Stufe für jede
Spiegelung, und die Vorschau zeigt das Ergebnis.

### Was passiert mit einer Serie?

Jeder Termin einer Serie wird einzeln gespiegelt. Wird ein Termin verschoben, wandert seine Kopie
mit. Wird er abgesagt, verschwindet seine Kopie.

### Brauche ich einen Server?

Nein. slotmirror läuft heute in deinem eigenen Cloudflare-Konto, im Workers-Free-Plan. Ein großes
Team kann Workers Paid brauchen. Siehe [Limits](../../../docs/limits/).

## Verwandte Anleitungen

- [Privaten Kalender bei der Arbeit als belegt zeigen](../show-private-calendar-as-busy-at-work/)
- [Kalender über Microsoft-365-Tenants synchronisieren](../sync-multiple-microsoft-365-tenants/)
