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

async function checkDataFlowStatus() {
  try {
    const latestDoc = await MachineData.findOne().sort({ timestamp: -1 });

    if (!latestDoc) {
      return {
        ok: false,
        message: "⚠️ No data found in the database yet.",
        lastUpdate: null,
        delayMinutes: null,
      };
    }

    const now = new Date();
    const diffMs = now - new Date(latestDoc.timestamp);
    const diffMinutes = diffMs / 60000;

    if (diffMinutes > ALERT_THRESHOLD_MINUTES) {
      return {
        ok: false,
        message: `⚠️ No new data received for ${diffMinutes.toFixed(
          1
        )} minute(s).`,
        lastUpdate: latestDoc.timestamp,
        delayMinutes: +diffMinutes.toFixed(1),
      };
    }

    return {
      ok: true,
      message: "✅ Dataflow is healthy and up to date.",
      lastUpdate: latestDoc.timestamp,
      delayMinutes: +diffMinutes.toFixed(1),
    };
  } catch (err) {
    console.error("checkDataFlowStatus error:", err);
    return {
      ok: false,
      message: "❌ Failed to check dataflow status.",
      lastUpdate: null,
      delayMinutes: null,
    };
  }
}

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: "500mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));

// MongoDB
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017/factory_monitor";
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.error("❌ MongoDB Connection Error:", err));

// HTTP + WebSocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/machine-data" });

// Broadcast helper
function broadcastToDashboards(payload) {
  const str = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(str);
    }
  });
}

// Helper: broadcast a "latest" summary for specific machines
function broadcastLatestForMachines(docs) {
  const payload = docs.map((d) => ({
    type: "machine_update",
    id: d._id,
    timestamp: d.timestamp,
    machine: d.machineName,
    status: d.status,
    shift: d.shift,
  }));
  broadcastToDashboards(payload);
}

// Save helper
async function saveBatchAndBroadcast(items) {
  const saved = [];
  for (const item of items) {
    try {
      const {
        timestamp,
        machine,
        status,
        durationSeconds = 0,
        shift = null,
      } = item;

      const ts = new Date(timestamp);
      if (isNaN(ts.getTime())) continue;

      const exists = await MachineData.findOne({
        timestamp: ts,
        machineName: machine,
      });
      if (exists) continue;

      const newDoc = new MachineData({
        timestamp: ts,
        machineName: machine,
        status: status || "UNKNOWN",
        machinePower: status === "RUNNING" || status === "DOWNTIME",
        downtime: status === "DOWNTIME",
        shift,
        durationSeconds,
      });

      await newDoc.save();
      saved.push(newDoc);
    } catch (err) {
      console.error("Error saving item:", err);
    }
  }

  if (saved.length) broadcastLatestForMachines(saved);
  return saved;
}

/* ---------------- WebSocket listener ---------------- */
wss.on("connection", (ws) => {
  console.log("🔌 Dashboard or Collector connected via WebSocket");

  ws.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      const items = Array.isArray(data) ? data : [data];
      const saved = await saveBatchAndBroadcast(items);
      ws.send(JSON.stringify({ ok: true, saved: saved.length }));
    } catch (err) {
      console.error("❌ WebSocket message error:", err);
      try {
        ws.send(JSON.stringify({ ok: false, error: err.message }));
      } catch {}
    }
  });

  ws.on("close", () => {
    console.log("❌ WebSocket client disconnected");
  });
});

/* ---------------- HTTP routes ---------------- */
app.get("/", (req, res) => res.send("Factory Monitoring Backend Running"));

// Collector data POST
app.post("/api/machine-data", async (req, res) => {
  try {
    const body = Array.isArray(req.body) ? req.body : [req.body];
    const saved = await saveBatchAndBroadcast(body);
    res.status(201).json({ message: "Saved", count: saved.length });
  } catch (err) {
    console.error("Error in /api/machine-data:", err);
    res.status(500).json({ error: "Failed to save machine data" });
  }
});

// Get machine data (last 24h default)
app.get("/api/machine-data", async (req, res) => {
  try {
    const { machine, from, to, limit } = req.query;
    const q = {};

    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    if (machine) q.machineName = machine;

    q.timestamp = {
      $gte: from ? new Date(from) : last24h,
      $lte: to ? new Date(to) : now,
    };

    const docs = await MachineData.find(q)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit) || 1000);

    res.json(docs);
  } catch (err) {
    console.error("❌ Fetch error:", err);
    res.status(500).json({ error: "Failed to fetch data" });
  }
});

/* ---------------- Dashboard APIs ---------------- */

// 1️⃣ Overview
app.get("/api/dashboard/overview", async (req, res) => {
  try {
    const latest = await MachineData.aggregate([
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: "$machineName",
          latestStatus: { $first: "$status" },
          lastTimestamp: { $first: "$timestamp" },
          shift: { $first: "$shift" },
        },
      },
      {
        $project: {
          machineName: "$_id",
          latestStatus: 1,
          lastTimestamp: 1,
          shift: 1,
          _id: 0,
        },
      },
      { $sort: { machineName: 1 } },
    ]);

    res.json(latest);
  } catch (err) {
    console.error("❌ /dashboard/overview error:", err);
    res.status(500).json({ error: "Failed to fetch overview" });
  }
});

// 2️⃣ Stats
app.get("/api/dashboard/stats", async (req, res) => {
  try {
    const latest = await MachineData.aggregate([
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: "$machineName",
          latestStatus: { $first: "$status" },
        },
      },
      {
        $group: {
          _id: "$latestStatus",
          count: { $sum: 1 },
        },
      },
    ]);

    const result = {};
    latest.forEach((g) => (result[g._id || "UNKNOWN"] = g.count));

    res.json(result);
  } catch (err) {
    console.error("❌ /dashboard/stats error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// 3️⃣ History trend
app.get("/api/dashboard/history", async (req, res) => {
  try {
    const { from, to } = req.query;
    const now = new Date();
    const fromTime = from
      ? new Date(from)
      : new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const toTime = to ? new Date(to) : now;

    const history = await MachineData.aggregate([
      { $match: { timestamp: { $gte: fromTime, $lte: toTime } } },
      {
        $group: {
          _id: { machineName: "$machineName", status: "$status" },
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          machineName: "$_id.machineName",
          status: "$_id.status",
          count: 1,
          _id: 0,
        },
      },
    ]);

    res.json(history);
  } catch (err) {
    console.error("❌ /dashboard/history error:", err);
    res.status(500).json({ error: "Failed to fetch dashboard history" });
  }
});

/* ---------------- CSV Export ---------------- */
app.get("/api/export", async (req, res) => {
  try {
    const { from, to, machine } = req.query;
    const q = {};
    if (machine) q.machineName = machine;
    if (from || to) q.timestamp = {};
    if (from) q.timestamp.$gte = new Date(from);
    if (to) q.timestamp.$lte = new Date(to);

    const docs = await MachineData.find(q).sort({ timestamp: 1 }).lean();
    const fields = [
      "timestamp",
      "machineName",
      "status",
      "machinePower",
      "downtime",
      "shift",
      "durationSeconds",
    ];
    const parser = new Parser({ fields });
    const csv = parser.parse(docs);

    res.header("Content-Type", "text/csv");
    res.attachment(`machine-data-${machine || "all"}-${Date.now()}.csv`);
    return res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to export CSV" });
  }
});

/* ---------------- Retention cron job ---------------- */
const retentionMonths = parseInt(process.env.RETENTION_MONTHS || "3");
const ARCHIVE_DIR = path.join(__dirname, "archives");
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR);

cron.schedule("0 3 * * *", async () => {
  try {
    console.log("🕒 Running retention cron job");
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - retentionMonths);

    const oldDocs = await MachineData.find({
      timestamp: { $lte: cutoff },
    }).lean();

    if (!oldDocs.length) {
      console.log("No old records to archive.");
      return;
    }

    const filename = `archive-${
      cutoff.toISOString().split("T")[0]
    }-${Date.now()}.json`;
    const filepath = path.join(ARCHIVE_DIR, filename);

    fs.writeFileSync(filepath, JSON.stringify(oldDocs, null, 2));
    console.log(`💾 Archived ${oldDocs.length} records to ${filepath}`);

    const ids = oldDocs.map((d) => d._id);
    const del = await MachineData.deleteMany({ _id: { $in: ids } });
    console.log(`🗑 Deleted ${del.deletedCount} old records`);
  } catch (err) {
    console.error("Retention job error:", err);
  }
});

//  -------------------------------- Data Flow Alert cron job ----------------

// REST API Endpoint
app.get("/api/alerts/dataflow", async (req, res) => {
  try {
    const status = await checkDataFlowStatus();
    res.json({
      updatedAt: new Date(),
      thresholdMinutes: ALERT_THRESHOLD_MINUTES,
      ...status,
    });
  } catch (err) {
    console.error("❌ /api/alerts/dataflow error:", err);
    res.status(500).json({ error: "Failed to check data flow status" });
  }
});

// (Optional) WebSocket broadcast every 2- minutes for live alert updates
setInterval(async () => {
  try {
    const status = await checkDataFlowStatus();
    broadcastToDashboards({
      type: "dataflow_alert",
      timestamp: new Date(),
      ...status,
    });
  } catch (err) {
    console.error("Data flow alert broadcast error:", err);
  }
}, ALERT_THRESHOLD_MINUTES * 60 * 1000);

/* ---------------- Start server ---------------- */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
