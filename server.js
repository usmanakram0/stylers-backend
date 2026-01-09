require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");
const bodyParser = require("body-parser");
const { Parser } = require("json2csv");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const MachineData = require("./models/machineData");

const app = express();
const ALERT_THRESHOLD_MINUTES = 10;

/* =========================================================
   🕒 TIME HELPERS (SAFE)
   ========================================================= */

// Parse ISO timestamp WITH or WITHOUT offset → UTC Date
function parseToUTC(value) {
  if (!value) return null;

  const d = new Date(value);
  if (isNaN(d.getTime())) return null;

  // JS Date always stores internally as UTC
  return d;
}

// Convert UTC Date → LOCAL Date for frontend
function utcToLocal(date) {
  if (!date) return null;
  return new Date(date.getTime() + date.getTimezoneOffset() * 60000);
}

/* =========================================================
   Middleware
   ========================================================= */
app.use(cors());
app.use(bodyParser.json({ limit: "100mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

/* =========================================================
   MongoDB
   ========================================================= */
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017/factory_monitor";

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Connection Error:", err));

/* =========================================================
   HTTP + WebSocket
   ========================================================= */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/machine-data" });

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((c) => c.readyState === c.OPEN && c.send(msg));
}

/* =========================================================
   🧠 SAVE LOGIC (ORDER SAFE + IDEMPOTENT)
   ========================================================= */
async function saveBatch(items) {
  const saved = [];

  for (const item of items) {
    const {
      timestamp,
      machine,
      status,
      durationSeconds = 0,
      shift = null,
    } = item;

    const tsUTC = parseToUTC(timestamp);
    if (!tsUTC || !machine) continue;

    // ❌ Ignore stale packets
    const latest = await MachineData.findOne({
      machineName: machine,
    }).sort({ timestamp: -1 });

    if (latest && tsUTC <= latest.timestamp) continue;

    try {
      const doc = await MachineData.create({
        timestamp: tsUTC,
        machineName: machine,
        status: status || "UNKNOWN",
        machinePower: status === "RUNNING" || status === "DOWNTIME",
        downtime: status === "DOWNTIME",
        shift,
        durationSeconds,
      });

      saved.push(doc);
    } catch (err) {
      // Duplicate safety (DB-level)
      if (err.code !== 11000) {
        console.error("Save error:", err);
      }
    }
  }

  if (saved.length) {
    broadcast(
      saved.map((d) => ({
        type: "machine_update",
        machine: d.machineName,
        status: d.status,
        shift: d.shift,
        timestamp: utcToLocal(d.timestamp),
      }))
    );
  }

  return saved;
}

/* =========================================================
   REST APIs
   ========================================================= */
app.get("/", (_, res) => res.send("✅ Factory Monitoring Backend Running"));

app.post("/api/machine-data", async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const saved = await saveBatch(items);
  res.status(201).json({ ok: true, saved: saved.length });
});

/* ---------- GET (LOCAL filters) ---------- */
app.get("/api/machine-data", async (req, res) => {
  const { machine, from, to, limit = 1000 } = req.query;
  const q = {};

  if (machine) q.machineName = machine;

  q.timestamp = {
    $gte: from ? parseToUTC(from) : new Date(Date.now() - 86400000),
    $lte: to ? parseToUTC(to) : new Date(),
  };

  const docs = await MachineData.find(q)
    .sort({ timestamp: -1 })
    .limit(+limit)
    .lean();

  res.json(
    docs.map((d) => ({
      ...d,
      timestamp: utcToLocal(d.timestamp),
    }))
  );
});

/* =========================================================
   DASHBOARD
   ========================================================= */
app.get("/api/dashboard/overview", async (_, res) => {
  const rows = await MachineData.aggregate([
    { $sort: { timestamp: -1 } },
    {
      $group: {
        _id: "$machineName",
        status: { $first: "$status" },
        timestamp: { $first: "$timestamp" },
        shift: { $first: "$shift" },
      },
    },
  ]);

  res.json(
    rows.map((r) => ({
      machineName: r._id,
      latestStatus: r.status,
      lastTimestamp: utcToLocal(r.timestamp),
      shift: r.shift,
    }))
  );
});

app.get("/api/dashboard/stats", async (_, res) => {
  const stats = await MachineData.aggregate([
    { $sort: { timestamp: -1 } },
    { $group: { _id: "$machineName", status: { $first: "$status" } } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);

  const result = {};
  stats.forEach((s) => (result[s._id || "UNKNOWN"] = s.count));
  res.json(result);
});

/* =========================================================
   CSV EXPORT
   ========================================================= */
app.get("/api/export", async (req, res) => {
  const { from, to, machine } = req.query;
  const q = {};

  if (machine) q.machineName = machine;
  if (from || to) {
    q.timestamp = {};
    if (from) q.timestamp.$gte = parseToUTC(from);
    if (to) q.timestamp.$lte = parseToUTC(to);
  }

  const docs = await MachineData.find(q).sort({ timestamp: 1 }).lean();

  const csv = new Parser({
    fields: [
      "timestamp",
      "machineName",
      "status",
      "machinePower",
      "downtime",
      "shift",
      "durationSeconds",
    ],
  }).parse(
    docs.map((d) => ({
      ...d,
      timestamp: utcToLocal(d.timestamp),
    }))
  );

  res.header("Content-Type", "text/csv");
  res.attachment(`machine-data-${Date.now()}.csv`);
  res.send(csv);
});

/* =========================================================
   RETENTION CRON
   ========================================================= */
cron.schedule("0 3 * * *", async () => {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 3);

  const old = await MachineData.find({ timestamp: { $lte: cutoff } }).lean();
  if (!old.length) return;

  fs.writeFileSync(
    path.join(__dirname, "archives", `archive-${Date.now()}.json`),
    JSON.stringify(old, null, 2)
  );

  await MachineData.deleteMany({ _id: { $in: old.map((d) => d._id) } });
});

/* =========================================================
   SERVER
   ========================================================= */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
