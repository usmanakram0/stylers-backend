const mongoose = require("mongoose");

const MachineDataSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, required: true, index: true },
    machineName: { type: String, required: true, index: true },
    status: { type: String, default: "UNKNOWN" }, // RUNNING, OFF, DOWNTIME
    machinePower: { type: Boolean, default: false },
    downtime: { type: Boolean, default: false },
    shift: { type: String, default: null },
    durationSeconds: { type: Number, default: 0 }, // useful for intervals
  },
  { timestamps: true }
);

module.exports = mongoose.model("MachineData", MachineDataSchema);
