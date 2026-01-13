const express = require("express");
const router = express.Router();
const LiveStatus = require("../models/LiveStatus");

/* =========================================================
   UTILITY FUNCTIONS
   ========================================================= */

// Convert UTC Date → Pakistan Time for frontend (UTC+5)
function utcToPKT(date) {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  const PKT_OFFSET = 5 * 60 * 60 * 1000; // +5 hours in milliseconds
  return new Date(d.getTime() + PKT_OFFSET).toISOString();
}

// Calculate shift from hour (PKT time)
function getShiftFromHour(hour) {
  if (hour >= 7 && hour < 15) return "Morning";
  if (hour >= 15 && hour < 23) return "Evening";
  return "Night";
}

/* =========================================================
   GET: All live statuses
   ========================================================= */
router.get("/", async (req, res) => {
  console.log("📡 GET /api/live-status - Fetching all live statuses");

  try {
    const statuses = await LiveStatus.find({}).sort({ machineName: 1 }).lean();

    const now = new Date();
    const results = statuses.map((status) => {
      const secondsSinceUpdate = Math.floor((now - status.lastUpdated) / 1000);

      return {
        ...status,
        lastUpdatedPKT: utcToPKT(status.lastUpdated),
        lastChangePKT: utcToPKT(status.lastChange),
        secondsSinceUpdate,
        isOnline: secondsSinceUpdate < 60, // Online if updated in last minute
        _id: status._id.toString(),
      };
    });

    console.log(`✅ Live status: ${results.length} machines retrieved`);
    res.json(results);
  } catch (err) {
    console.error("❌ Error fetching live statuses:", err);
    res.status(500).json({
      error: "Failed to fetch live statuses",
      details: err.message,
    });
  }
});

/* =========================================================
   GET: Single machine live status
   ========================================================= */
router.get("/:machineName", async (req, res) => {
  const { machineName } = req.params;
  console.log(`📡 GET /api/live-status/${machineName}`);

  try {
    const status = await LiveStatus.findOne({
      machineName: machineName,
    }).lean();

    if (!status) {
      return res.status(404).json({
        error: "Machine not found in live status collection",
      });
    }

    const now = new Date();
    const secondsSinceUpdate = Math.floor((now - status.lastUpdated) / 1000);

    const result = {
      ...status,
      lastUpdatedPKT: utcToPKT(status.lastUpdated),
      lastChangePKT: utcToPKT(status.lastChange),
      secondsSinceUpdate,
      isOnline: secondsSinceUpdate < 60,
      _id: status._id.toString(),
    };

    res.json(result);
  } catch (err) {
    console.error(`❌ Error fetching live status for ${machineName}:`, err);
    res.status(500).json({
      error: "Failed to fetch machine status",
      details: err.message,
    });
  }
});

/* =========================================================
   POST: Update live status (called by collector every 30s)
   ========================================================= */
router.post("/update", async (req, res) => {
  const updates = Array.isArray(req.body) ? req.body : [req.body];
  console.log(`📥 POST /api/live-status/update - ${updates.length} machines`);

  const results = [];
  const now = new Date();

  for (const update of updates) {
    const { machine, status, machinePower, downtime, shift, timestamp } =
      update;

    if (!machine) {
      console.log("⚠️ Skipping update: No machine name provided");
      results.push({
        machine: "unknown",
        error: "No machine name",
        updated: false,
      });
      continue;
    }

    try {
      // Find existing document for this machine
      const existing = await LiveStatus.findOne({ machineName: machine });

      let result;
      const updateTime = timestamp ? new Date(timestamp) : now;

      if (existing) {
        // Update existing document
        const statusChanged = existing.status !== status;

        // Calculate new uptime
        let newUptimeSeconds = existing.uptimeSeconds || 0;
        if (existing.status === "RUNNING" && !statusChanged) {
          // If still running, add time since last update
          const timeDiff = Math.floor(
            (updateTime - existing.lastUpdated) / 1000
          );
          newUptimeSeconds += Math.max(0, timeDiff);
        } else if (status === "RUNNING") {
          // Starting fresh run
          newUptimeSeconds = 0;
        } else if (statusChanged) {
          // Status changed from running to something else
          newUptimeSeconds = 0;
        }

        // Prepare update data
        const updateData = {
          status: status || "UNKNOWN",
          machinePower: machinePower || false,
          downtime: downtime || false,
          shift: shift || existing.shift || "Unknown",
          lastUpdated: updateTime,
          lastPolled: now,
          uptimeSeconds: newUptimeSeconds,
          isOnline: true,
        };

        // Update lastChange only if status actually changed
        if (statusChanged) {
          updateData.lastChange = updateTime;
        }

        // Perform update
        result = await LiveStatus.findOneAndUpdate(
          { machineName: machine },
          updateData,
          {
            new: true, // Return updated document
            runValidators: true,
          }
        );
      } else {
        // Create new document for this machine
        result = await LiveStatus.create({
          machineName: machine,
          status: status || "UNKNOWN",
          machinePower: machinePower || false,
          downtime: downtime || false,
          shift: shift || "Unknown",
          lastUpdated: updateTime,
          lastChange: updateTime,
          lastPolled: now,
          uptimeSeconds: 0,
          isOnline: true,
        });
      }

      results.push({
        machine: machine,
        status: result.status,
        updated: true,
        isNew: !existing,
      });

      // Log the update
      console.log(
        `  ✅ ${machine}: ${result.status} (Power: ${
          result.machinePower ? "ON" : "OFF"
        }, Downtime: ${result.downtime ? "YES" : "NO"})`
      );
    } catch (err) {
      console.error(`❌ Failed to update ${machine}:`, err.message);
      results.push({
        machine: machine,
        error: err.message,
        updated: false,
      });
    }
  }

  // Count successes
  const successfulUpdates = results.filter((r) => r.updated).length;

  console.log(
    `✅ Live status update completed: ${successfulUpdates}/${updates.length} machines updated`
  );

  res.json({
    success: true,
    timestamp: now.toISOString(),
    updated: successfulUpdates,
    total: updates.length,
    results: results,
  });
});

/* =========================================================
   POST: Initialize live status collection (one-time setup)
   ========================================================= */
router.post("/initialize", async (req, res) => {
  console.log(
    "🚀 POST /api/live-status/initialize - Initializing live status collection"
  );

  try {
    // Get MachineData model from your existing code
    const MachineData = require("../models/machineData");

    // Get all unique machines from historical data
    const machines = await MachineData.distinct("machineName");
    console.log(`🔍 Found ${machines.length} machines in historical data`);

    const initialized = [];
    const skipped = [];
    const now = new Date();

    for (const machineName of machines) {
      try {
        // Get the latest status for each machine
        const latest = await MachineData.findOne({ machineName })
          .sort({ timestamp: -1 })
          .lean();

        if (latest) {
          // Check if already exists in LiveStatus
          const existing = await LiveStatus.findOne({ machineName });

          if (!existing) {
            // Create new live status document
            await LiveStatus.create({
              machineName: machineName,
              status: latest.status || "UNKNOWN",
              machinePower: latest.machinePower || false,
              downtime: latest.downtime || false,
              shift: latest.shift || "Unknown",
              lastUpdated: latest.timestamp || now,
              lastChange: latest.timestamp || now,
              lastPolled: now,
              uptimeSeconds: 0,
              isOnline: false, // Will become true when collector updates
            });

            initialized.push(machineName);
            console.log(`  ✅ Created: ${machineName} - ${latest.status}`);
          } else {
            skipped.push(machineName);
            console.log(`  ⏭️ Skipped (already exists): ${machineName}`);
          }
        }
      } catch (err) {
        console.error(`  ❌ Error initializing ${machineName}:`, err.message);
      }
    }

    // Also ensure we have documents for all expected machines (33 total)
    const totalCount = await LiveStatus.countDocuments();

    res.json({
      success: true,
      message: "Live status collection initialized",
      initialized: initialized.length,
      skipped: skipped.length,
      totalInCollection: totalCount,
      initializedMachines: initialized,
      skippedMachines: skipped,
    });
  } catch (err) {
    console.error("❌ Initialization error:", err);
    res.status(500).json({
      error: "Failed to initialize live status collection",
      details: err.message,
    });
  }
});

/* =========================================================
   GET: Live status statistics
   ========================================================= */
router.get("/stats/overview", async (req, res) => {
  console.log("📊 GET /api/live-status/stats/overview");

  try {
    const now = new Date();
    const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

    // Get status counts
    const statusCounts = await LiveStatus.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);

    // Get online/offline counts
    const onlineCount = await LiveStatus.countDocuments({
      lastUpdated: { $gte: oneMinuteAgo },
    });

    const staleCount = await LiveStatus.countDocuments({
      lastUpdated: { $lt: oneMinuteAgo, $gte: fiveMinutesAgo },
    });

    const offlineCount = await LiveStatus.countDocuments({
      lastUpdated: { $lt: fiveMinutesAgo },
    });

    // Format results
    const stats = {
      RUNNING: 0,
      DOWNTIME: 0,
      OFF: 0,
      UNKNOWN: 0,
    };

    statusCounts.forEach((item) => {
      stats[item._id] = item.count;
    });

    const totalMachines = await LiveStatus.countDocuments();

    res.json({
      timestamp: now.toISOString(),
      totalMachines,
      statusCounts: stats,
      connectivity: {
        online: onlineCount,
        stale: staleCount,
        offline: offlineCount,
      },
      lastUpdated: utcToPKT(now),
    });
  } catch (err) {
    console.error("❌ Error getting live status stats:", err);
    res.status(500).json({
      error: "Failed to get live status statistics",
      details: err.message,
    });
  }
});

/* =========================================================
   DELETE: Reset live status collection (for testing)
   ========================================================= */
router.delete("/reset", async (req, res) => {
  console.log(
    "🔄 DELETE /api/live-status/reset - Resetting live status collection"
  );

  try {
    const result = await LiveStatus.deleteMany({});

    res.json({
      success: true,
      message: "Live status collection reset",
      deletedCount: result.deletedCount,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ Error resetting live status:", err);
    res.status(500).json({
      error: "Failed to reset live status collection",
      details: err.message,
    });
  }
});

module.exports = router;
