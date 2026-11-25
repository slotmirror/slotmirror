---
title: Privaten Kalender bei der Arbeit als belegt zeigen
description: Blocke Zeit im Arbeitskalender für private Termine, ohne dass Kolleginnen und Kollegen sehen, worum es geht.
sidebar:
  order: 2
---

Kolleginnen und Kollegen buchen dich für ein Meeting, während du beim Zahnarzt bist. Sie sehen
deinen privaten Kalender nicht, also wissen sie es nicht. Diese Anleitung setzt für jeden privaten
Termin einen Block „Belegt“ in deinen Arbeitskalender, und sonst nichts.

## Warum es nicht reicht, den Kalender in Outlook hinzuzufügen

Du kannst einen privaten Kalender in Outlook hinzufügen, als Abo oder über eine Freigabe. Dann
siehst du deine privaten Termine neben der Arbeit. Wer nachsieht, wann du frei bist, sieht aber
weiterhin nur deinen Arbeitskalender. Blöcke, die du von Hand kopierst, veralten, sobald sich ein
Termin verschiebt.

slotmirror schreibt für jeden privaten Termin einen Block in deinen Arbeitskalender. Ändert sich
der Termin, verschiebt oder entfernt es den Block.

## Schritte

1. Richte slotmirror mit dem [Quickstart](../../../docs/quickstart/) ein und verbinde dein Arbeits-
   und dein privates Konto.
2. Öffne die Seite **Spiegelung** und wähle **Alle als belegt spiegeln**. Jeder Kalender zeigt
   dann die Termine des anderen als belegt.
3. Öffne die Zeile vom privaten Konto zum Arbeitskalender. Lass unter **Was kopiert wird** die
   Stufe **Nur belegt** stehen.
4. Lass **Was andere sehen** auf **Privater Termin**. Kolleginnen und Kollegen sehen dann einen
   privaten Termin, im Google Kalender „Belegt“. Du siehst weiterhin alles.
5. Wähle **Speichern**.

## Den Titel der Kopien wählen

Die Kopien tragen den Titel aus **Titel der Kopien bei „Nur belegt“**, zum Beispiel „Belegt“ oder „Geblockt“.
Titel, Ort und Teilnehmende des privaten Termins gelangen nicht in den Arbeitskalender.

## Für ein Team

Ein Admin kann das für alle festlegen: `MAX_DETAIL_FROM_EXTERNAL=busy` begrenzt jede Richtung von
einem privaten Konto zu einem Arbeitskonto auf „Belegt“. Siehe
[Organisations](../../../docs/organisations/).

## Fragen

### Sehen Kolleginnen und Kollegen, worum es bei dem Termin geht?

Nein. Eine Kopie trägt den Titel aus **Titel der Kopien bei „Nur belegt“** unter **Für alle
Spiegelungen**, standardmäßig „Belegt“. **Was andere sehen** steht standardmäßig auf **Privater
Termin**. Wer deinen Kalender öffnen darf, sieht deshalb einen privaten Termin, im Google Kalender
„Belegt“. Wer nur nachsieht, wann du frei bist, sieht, dass du belegt bist. Titel, Ort und
Teilnehmende des Termins bleiben in deinem privaten Kalender.

### Wer hat Zugriff auf meinen privaten Kalender?

Wer die Installation betreibt. Richtest du slotmirror selbst ein, liegen die Tokens in deinem
eigenen Cloudflare-Konto. Betreibt dein Arbeitgeber die Installation, liegen sie in dessen Konto.
Die Seite `/privacy` der Installation zeigt den Kontakt des Betreibers, wenn er einen eingetragen
hat. Siehe [Privacy and data location](../../../docs/privacy/).

### Was ist mit Feiertagen und freien Tagen?

Ganztägige Termine blocken standardmäßig den ganzen Tag. Termine, die als frei markiert sind,
bleiben draußen. Um alle ganztägigen Termine auszulassen, schalte **Ganztägige Termine überspringen**
unter **Für alle Spiegelungen** auf der Seite **Spiegelung** ein.

## Verwandte Anleitungen

- [Outlook und Google Kalender synchronisieren](../sync-outlook-and-google-calendar/)
- [Zeit für einen Team- oder Vereinskalender blocken](../block-team-or-club-calendar/)
