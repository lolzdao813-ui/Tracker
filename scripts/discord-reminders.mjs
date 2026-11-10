import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const roomId = "22849ef54df441cab4da10069d2c7788";
const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
if (!webhookUrl) {
  throw new Error("Missing DISCORD_WEBHOOK_URL secret.");
}

if (process.env.TEST_DISCORD === "true") {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Tracker Reminder",
      embeds: [{
        title: "✅ Tes koneksi Discord berhasil!",
        description: "Tracker berhasil mengirim pesan ke channel ini. Pengingat otomatis H-3 dan hari jatuh tempo sudah siap digunakan.",
        color: 5763719,
        fields: [
          { name: "Mode", value: "Pesan percobaan", inline: true },
          { name: "Zona waktu", value: "Asia/Jakarta (WIB)", inline: true }
        ],
        footer: { text: "Tracker Reminder Bot" },
        timestamp: new Date().toISOString()
      }],
      allowed_mentions: { parse: [] }
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord test webhook failed (${response.status}): ${body.slice(0, 500)}`);
  }
  console.log("Discord test message sent successfully. Firestore was not accessed or changed.");
  process.exit(0);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
if (!serviceAccount.project_id) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON secret.");
}

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const timeZone = "Asia/Jakarta";
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

const todayDate = new Date(`${today}T00:00:00+07:00`);
const formatRupiah = (value) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));

const debtsSnapshot = await db
  .collection("rooms")
  .doc(roomId)
  .collection("debts")
  .get();

let sent = 0;
let skipped = 0;

for (const debtDoc of debtsSnapshot.docs) {
  const debt = debtDoc.data();
  if (!debt.dueDate || Number(debt.amount || 0) - Number(debt.totalPaid || 0) <= 0) {
    continue;
  }

  const dueDate = new Date(`${debt.dueDate}T00:00:00+07:00`);
  if (Number.isNaN(dueDate.getTime())) continue;

  const daysUntilDue = Math.round((dueDate - todayDate) / 86400000);
  const reminderType = daysUntilDue === 3 ? "H-3" : daysUntilDue === 0 ? "H" : null;
  if (!reminderType) continue;

  const logId = Buffer.from(`${debtDoc.id}_${debt.dueDate}_${reminderType}`).toString("base64url");
  const logRef = db.collection("rooms").doc(roomId).collection("reminderLogs").doc(logId);
  const existingLog = await logRef.get();
  if (existingLog.exists) {
    skipped++;
    continue;
  }

  const remaining = Math.max(0, Number(debt.amount || 0) - Number(debt.totalPaid || 0));
  const title = reminderType === "H" ? "⚠️ Jatuh tempo hari ini" : "🔔 Pengingat jatuh tempo H-3";
  const payload = {
    username: "Tracker Reminder",
    embeds: [{
      title,
      color: reminderType === "H" ? 15158332 : 15844367,
      fields: [
        { name: "Pemberi utang", value: String(debt.creditor || "Tidak diketahui").slice(0, 1024), inline: true },
        { name: "Sisa utang", value: formatRupiah(remaining), inline: true },
        { name: "Jatuh tempo", value: debt.dueDate, inline: true },
      ],
      footer: { text: "Pengingat otomatis dari Tracker" },
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord webhook failed (${response.status}): ${body.slice(0, 500)}`);
  }

  await logRef.set({
    debtId: debtDoc.id,
    dueDate: debt.dueDate,
    reminderType,
    sentAt: FieldValue.serverTimestamp(),
  });
  sent++;
}

console.log(`Reminder check complete. Sent: ${sent}; already sent: ${skipped}; date (WIB): ${today}`);
