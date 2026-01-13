const mongoose = require("mongoose");

const LiveStatusSchema = new mongoose.Schema(
  {
    // Machine name (e.g., "Machine_1", "Hanger")
    machineName: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },

    // Current status: RUNNING | DOWNTIME | OFF | UNKNOWN
    status: {
      type: String,
      enum: ["RUNNING", "DOWNTIME", "OFF", "UNKNOWN"],
      default: "UNKNOWN",
      index: true,
    },

    // Power state from Access DB
    machinePower: {
      type: Boolean,
      default: false,
    },

    // Downtime flag from Access DB
    downtime: {
      type: Boolean,
      default: false,
    },

    // Current shift based on Pakistan time
    shift: {
      type: String,
      enum: ["Morning", "Evening", "Night", "Unknown"],
      default: "Unknown",
    },

    // When this status was last updated (UTC)
    lastUpdated: {
      type: Date,
      default: Date.now,
      index: true,
    },

    // When status last changed (UTC)
    lastChange: {
      type: Date,
      default: Date.now,
    },

    // How long machine has been in current status (seconds)
    // Only increments for RUNNING status
    uptimeSeconds: {
      type: Number,
      default: 0,
      min: 0,
    },

    // When we last polled this machine (for monitoring)
    lastPolled: {
      type: Date,
      default: Date.now,
    },

    // For tracking connectivity
    isOnline: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true, // createdAt, updatedAt
    versionKey: false,
  }
);

// 🔐 Prevent duplicate machines
LiveStatusSchema.index({ machineName: 1 }, { unique: true });

// 🔍 Fast queries by status and last updated
LiveStatusSchema.index({ status: 1, lastUpdated: -1 });
LiveStatusSchema.index({ lastUpdated: -1 });

// Create the model
const LiveStatus = mongoose.model("LiveStatus", LiveStatusSchema);

module.exports = LiveStatus;
