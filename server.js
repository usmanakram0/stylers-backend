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
   🕒 TIME HELPERS (UPDATED FOR PAKISTAN TIME)
   ========================================================= */

// Parse ISO timestamp - handles naive (no timezone) as Pakistan Time (UTC+5)
function parseToUTC(value) {
  if (!value) return null;

  // If it's already a Date object
  if (value instanceof Date) {
    return value;
  }

  // If it's a string
  if (typeof value === "string") {
    // Check if it has timezone info
    const hasTimezone =
      value.includes("+") ||
      value.includes("Z") ||
      value.includes("-") ||
      value.includes(" ");

    if (!hasTimezone) {
      // Naive datetime (no timezone) - assume Pakistan Time (UTC+5)
      // Example: "2024-01-09T14:30:00"
      const dt = new Date(value);

      // Add 5 hours to convert PKT → UTC
      const pktOffset = 5 * 60 * 60 * 1000; // PKT is UTC+5
      const utcTime = new Date(dt.getTime() - pktOffset);

      if (!isNaN(utcTime.getTime())) {
        return utcTime;
      }
    } else {
      // Has timezone info, let Date handle it
      const dt = new Date(value);
      if (!isNaN(dt.getTime())) {
        return dt;
      }
    }
  }

  // Fallback
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// Convert UTC Date → Pakistan Time for frontend (UTC+5)
function utcToPKT(date) {
  if (!date) return null;

  // Ensure it's a valid Date object
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;

  // Convert UTC → PKT (UTC+5)
  const PKT_OFFSET = 5 * 60 * 60 * 1000; // +5 hours in milliseconds
  return new Date(d.getTime() + PKT_OFFSET).toISOString();
}

/* =========================================================
   Middleware
   ========================================================= */
app.use(cors());
app.use(bodyParser.json({ limit: "100mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  if (req.method === "POST" && req.body) {
    console.log(
      `📥 Request body length: ${Array.isArray(req.body) ? req.body.length : 1}`
    );
  }
  next();
});

/* =========================================================
   MongoDB
   ========================================================= */
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017/factory_monitor";

mongoose
  .connect(MONGO_URI)
  .then(async () => {
    console.log("✅ MongoDB Connected");

    // Create indexes for better performance
    try {
      await MachineData.createIndexes([
        {
          machineName: 1,
          timestamp: -1,
        },
        {
          timestamp: -1,
        },
      ]);
      console.log("✅ MongoDB indexes created");
    } catch (err) {
      console.log("ℹ️ Index creation note:", err.message);
    }
  })
  .catch((err) => console.error("❌ MongoDB Connection Error:", err));

/* =========================================================
   HTTP + WebSocket
   ========================================================= */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/machine-data" });

// WebSocket connection logging
wss.on("connection", (ws, req) => {
  console.log(`🔗 New WebSocket connection from ${req.socket.remoteAddress}`);
  ws.on("close", () => {
    console.log(
      `🔗 WebSocket connection closed from ${req.socket.remoteAddress}`
    );
  });
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  let count = 0;
  wss.clients.forEach((c) => {
    if (c.readyState === c.OPEN) {
      c.send(msg);
      count++;
    }
  });
  if (count > 0) {
    console.log(`📡 Broadcasted to ${count} WebSocket clients`);
  }
}

/* =========================================================
   🧠 SAVE LOGIC (UPDATED FOR NAIVE TIMESTAMPS)
   ========================================================= */
async function saveBatch(items) {
  console.log(`💾 Processing batch of ${items.length} items...`);
  const saved = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const {
      timestamp,
      machine,
      status,
      durationSeconds = 0,
      shift = null,
    } = item;

    console.log(
      `  Processing item ${i + 1}/${
        items.length
      }: ${machine} - ${status} - ${timestamp}`
    );

    const tsUTC = parseToUTC(timestamp);
    if (!tsUTC) {
      console.log(
        `  ⚠️ Skipping: Invalid timestamp "${timestamp}" for machine ${machine}`
      );
      continue;
    }

    if (!machine) {
      console.log(`  ⚠️ Skipping: No machine name`);
      continue;
    }

    // TEMPORARILY DISABLED: Check for stale/duplicate packets
    // This might be blocking valid data due to timezone confusion
    /*
    try {
      const latest = await MachineData.findOne({
        machineName: machine,
      }).sort({ timestamp: -1 });

      if (latest && tsUTC <= latest.timestamp) {
        console.log(`  ⏭️ Skipping duplicate/older data for ${machine}:`);
        console.log(`     New: ${tsUTC.toISOString()}, Latest in DB: ${latest.timestamp.toISOString()}`);
        continue;
      }
    } catch (err) {
      console.log(`  ℹ️ Could not check latest record for ${machine}:`, err.message);
    }
    */

    try {
      const doc = await MachineData.create({
        timestamp: tsUTC,
        machineName: machine,
        status: status || "UNKNOWN",
        machinePower: status === "RUNNING" || status === "DOWNTIME",
        downtime: status === "DOWNTIME",
        shift:
          shift ||
          (() => {
            // Calculate shift if not provided
            const hour = tsUTC.getUTCHours() + 5; // Convert UTC to PKT
            if (hour >= 7 && hour < 15) return "Morning";
            if (hour >= 15 && hour < 23) return "Evening";
            return "Night";
          })(),
        durationSeconds,
      });

      saved.push(doc);
      console.log(
        `  ✅ Saved: ${machine} at ${tsUTC.toISOString()} (UTC) - ${status}`
      );
    } catch (err) {
      // Duplicate safety (DB-level unique constraint)
      if (err.code === 11000) {
        console.log(
          `  ⏭️ MongoDB duplicate key prevented for ${machine} at ${tsUTC.toISOString()}`
        );
      } else {
        console.error(`  ❌ Save error for ${machine}:`, err.message);
      }
    }
  }

  if (saved.length > 0) {
    console.log(
      `📡 Broadcasting ${saved.length} saved items to WebSocket clients`
    );
    broadcast(
      saved.map((d) => ({
        type: "machine_update",
        machine: d.machineName,
        status: d.status,
        shift: d.shift,
        timestamp: utcToPKT(d.timestamp), // Send PKT time to frontend
      }))
    );
  } else {
    console.log(`📭 No items saved from this batch`);
  }

  return saved;
}

/* =========================================================
   REST APIs
   ========================================================= */
app.get("/", (_, res) => {
  res.json({
    message: "✅ Factory Monitoring Backend Running",
    version: "1.0",
    endpoints: {
      postData: "POST /api/machine-data",
      getData: "GET /api/machine-data?machine=&from=&to=&limit=",
      dashboard: "GET /api/dashboard/overview",
      stats: "GET /api/dashboard/stats",
      export: "GET /api/export?machine=&from=&to=",
    },
  });
});

app.post("/api/machine-data", async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];

  console.log(`📥 Received ${items.length} items from collector`);
  if (items.length > 0) {
    console.log(`📦 First item:`, {
      timestamp: items[0].timestamp,
      machine: items[0].machine,
      status: items[0].status,
      shift: items[0].shift,
    });
  }

  const saved = await saveBatch(items);

  res.status(201).json({
    ok: true,
    saved: saved.length,
    received: items.length,
    timestamp: new Date().toISOString(),
  });
});

/* ---------- GET DATA (returns PKT time) ---------- */
app.get("/api/machine-data", async (req, res) => {
  const { machine, from, to, limit = 1000 } = req.query;
  console.log(
    `📤 GET request: machine=${machine}, from=${from}, to=${to}, limit=${limit}`
  );

  const q = {};

  if (machine) q.machineName = machine;

  q.timestamp = {
    $gte: from ? parseToUTC(from) : new Date(Date.now() - 86400000), // Last 24 hours
    $lte: to ? parseToUTC(to) : new Date(),
  };

  try {
    const docs = await MachineData.find(q)
      .sort({ timestamp: -1 })
      .limit(Math.min(parseInt(limit), 5000)) // Cap at 5000 for safety
      .lean();

    console.log(`📊 Found ${docs.length} documents`);

    // Convert UTC timestamps to PKT for frontend
    const results = docs.map((d) => ({
      ...d,
      timestamp: utcToPKT(d.timestamp), // Convert to PKT
      _id: d._id.toString(),
    }));

    res.json(results);
  } catch (err) {
    console.error("❌ Error fetching data:", err);
    res
      .status(500)
      .json({ error: "Failed to fetch data", details: err.message });
  }
});

/* =========================================================
   DASHBOARD ENDPOINTS
   ========================================================= */
app.get("/api/dashboard/overview", async (_, res) => {
  try {
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

    const result = rows.map((r) => ({
      machineName: r._id,
      latestStatus: r.status,
      lastTimestamp: utcToPKT(r.timestamp), // PKT time
      shift: r.shift,
    }));

    console.log(`📊 Dashboard overview: ${result.length} machines`);
    res.json(result);
  } catch (err) {
    console.error("❌ Dashboard overview error:", err);
    res.status(500).json({ error: "Failed to get dashboard overview" });
  }
});

app.get("/api/dashboard/stats", async (_, res) => {
  try {
    const stats = await MachineData.aggregate([
      { $sort: { timestamp: -1 } },
      { $group: { _id: "$machineName", status: { $first: "$status" } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const result = {
      RUNNING: 0,
      DOWNTIME: 0,
      OFF: 0,
      UNKNOWN: 0,
      total: 0,
    };

    stats.forEach((s) => {
      const status = s._id || "UNKNOWN";
      result[status] = s.count;
      result.total += s.count;
    });

    console.log(`📊 Dashboard stats:`, result);
    res.json(result);
  } catch (err) {
    console.error("❌ Dashboard stats error:", err);
    res.status(500).json({ error: "Failed to get dashboard stats" });
  }
});

app.get("/api/machines/status", async (_, res) => {
  try {
    const rows = await MachineData.aggregate([
      { $sort: { timestamp: -1 } },
      { $group: { _id: "$machineName", status: { $first: "$status" } } },
    ]);

    const result = {};
    rows.forEach((r) => {
      result[r._id] = r.status;
    });

    console.log(`📊 Real-time status: ${Object.keys(result).length} machines`);
    res.json(result);
  } catch (err) {
    console.error("❌ Machine status error:", err);
    res.status(500).json({ error: "Failed to get machine statuses" });
  }
});

/* =========================================================
   CSV EXPORT
   ========================================================= */
app.get("/api/export", async (req, res) => {
  const { from, to, machine } = req.query;
  console.log(`📥 Export request: machine=${machine}, from=${from}, to=${to}`);

  const q = {};

  if (machine) q.machineName = machine;
  if (from || to) {
    q.timestamp = {};
    if (from) q.timestamp.$gte = parseToUTC(from);
    if (to) q.timestamp.$lte = parseToUTC(to);
  }

  try {
    const docs = await MachineData.find(q).sort({ timestamp: 1 }).lean();

    if (docs.length === 0) {
      return res
        .status(404)
        .json({ error: "No data found for the specified criteria" });
    }

    // Convert timestamps to PKT for export
    const exportData = docs.map((d) => ({
      ...d,
      timestamp: utcToPKT(d.timestamp),
      _id: d._id.toString(),
    }));

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
    }).parse(exportData);

    const filename = `machine-data-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;

    res.header("Content-Type", "text/csv");
    res.attachment(filename);
    res.send(csv);

    console.log(`✅ Exported ${docs.length} records to CSV`);
  } catch (err) {
    console.error("❌ Export error:", err);
    res
      .status(500)
      .json({ error: "Failed to export data", details: err.message });
  }
});

/* =========================================================
   HEALTH CHECK
   ========================================================= */
app.get("/health", async (_, res) => {
  try {
    // Check MongoDB connection
    await mongoose.connection.db.admin().ping();

    // Get some stats
    const totalRecords = await MachineData.countDocuments({});
    const latestRecord = await MachineData.findOne({}).sort({ timestamp: -1 });

    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      database: "connected",
      totalRecords,
      latestRecord: latestRecord
        ? {
            machine: latestRecord.machineName,
            timestamp: utcToPKT(latestRecord.timestamp),
            status: latestRecord.status,
          }
        : null,
      websocketClients: wss.clients.size,
    });
  } catch (err) {
    console.error("❌ Health check failed:", err);
    res.status(500).json({
      status: "unhealthy",
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

/* =========================================================
   RETENTION CRON
   ========================================================= */
cron.schedule("0 3 * * *", async () => {
  console.log("🔄 Running retention cron job...");
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 3);

  try {
    const old = await MachineData.find({ timestamp: { $lte: cutoff } }).lean();
    if (!old.length) {
      console.log("📭 No old records to archive");
      return;
    }

    // Ensure archive directory exists
    const archiveDir = path.join(__dirname, "archives");
    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }

    const archiveFile = path.join(archiveDir, `archive-${Date.now()}.json`);
    fs.writeFileSync(archiveFile, JSON.stringify(old, null, 2));

    await MachineData.deleteMany({ _id: { $in: old.map((d) => d._id) } });

    console.log(`✅ Archived ${old.length} records to ${archiveFile}`);
  } catch (err) {
    console.error("❌ Retention cron job failed:", err);
  }
});

/* =========================================================
   ERROR HANDLING MIDDLEWARE
   ========================================================= */
app.use((err, req, res, next) => {
  console.error("🔥 Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: err.message,
    timestamp: new Date().toISOString(),
  });
});

/* =========================================================
   SERVER
   ========================================================= */
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/api/dashboard/overview`);
});
