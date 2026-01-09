const mongoose = require("mongoose");

const MachineDataSchema = new mongoose.Schema(
  {
    // 🔴 Always stored in UTC (JS Date is UTC internally)
    timestamp: {
      type: Date,
      required: true,
      index: true,
    },

    machineName: {
      type: String,
      required: true,
      index: true,
    },

    // RUNNING | OFF | DOWNTIME
    status: {
      type: String,
      enum: ["RUNNING", "OFF", "DOWNTIME", "UNKNOWN"],
      default: "UNKNOWN",
    },

    machinePower: {
      type: Boolean,
      default: false,
    },

    downtime: {
      type: Boolean,
      default: false,
    },

    shift: {
      type: String,
      default: null,
    },

    // Duration until NEXT state change (seconds)
    durationSeconds: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true, // createdAt / updatedAt
    versionKey: false,
  }
);

/* =========================================================
   🔐 CRITICAL INDEXES
   ========================================================= */

// ✅ Prevent duplicates forever
MachineDataSchema.index({ machineName: 1, timestamp: 1 }, { unique: true });

// ✅ Fast "latest status per machine"
MachineDataSchema.index({ machineName: 1, timestamp: -1 });

// ✅ Fast time-range queries (dashboard, export)
MachineDataSchema.index({ timestamp: -1 });

module.exports = mongoose.model("MachineData", MachineDataSchema);
