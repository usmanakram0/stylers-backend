// remove-duplicates.js
require("dotenv").config();
const mongoose = require("mongoose");

// Your MongoDB URI - replace this or use .env file
const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://username:password@cluster.mongodb.net/factory_monitor";

async function removeDuplicates() {
  console.log("🚀 Starting duplicate removal...\n");

  try {
    // Connect to MongoDB
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    console.log("✅ Connected to MongoDB Atlas");

    // Define the schema (flexible to match your collection)
    const machineDataSchema = new mongoose.Schema({}, { strict: false });
    const MachineData = mongoose.model(
      "MachineData",
      machineDataSchema,
      "machinedatas",
    );

    // Step 1: Find all duplicate groups
    console.log("🔍 Finding duplicate records...");

    const duplicateGroups = await MachineData.aggregate([
      {
        $group: {
          _id: {
            machineName: "$machineName",
            timestamp: "$timestamp",
            status: "$status",
          },
          count: { $sum: 1 },
          ids: { $push: "$_id" },
        },
      },
      {
        $match: {
          count: { $gt: 1 },
        },
      },
    ]);

    if (duplicateGroups.length === 0) {
      console.log("🎉 No duplicates found!");
      await mongoose.disconnect();
      return;
    }

    console.log(`📊 Found ${duplicateGroups.length} duplicate groups`);
    console.log(
      `📝 Total duplicate records: ${duplicateGroups.reduce((sum, group) => sum + (group.count - 1), 0)}`,
    );

    // Step 2: Delete duplicates (keep only the first record in each group)
    console.log("\n🗑️  Removing duplicates...");

    let totalDeleted = 0;
    let processedGroups = 0;

    for (const group of duplicateGroups) {
      const idsToDelete = group.ids.slice(1); // Keep the first one, delete the rest

      if (idsToDelete.length > 0) {
        const result = await MachineData.deleteMany({
          _id: { $in: idsToDelete },
        });

        totalDeleted += result.deletedCount;
        processedGroups++;

        // Show progress every 10 groups
        if (processedGroups % 10 === 0) {
          console.log(
            `   Processed ${processedGroups}/${duplicateGroups.length} groups...`,
          );
        }
      }
    }

    console.log(`\n✅ Deleted ${totalDeleted} duplicate records`);
    console.log(
      `✅ Kept ${duplicateGroups.length} original records (one from each group)`,
    );

    // Step 3: Verify cleanup
    console.log("\n🔍 Verifying cleanup...");

    const remainingDuplicates = await MachineData.aggregate([
      {
        $group: {
          _id: {
            machineName: "$machineName",
            timestamp: "$timestamp",
            status: "$status",
          },
          count: { $sum: 1 },
        },
      },
      {
        $match: {
          count: { $gt: 1 },
        },
      },
      {
        $count: "duplicateGroups",
      },
    ]);

    const duplicateCount = remainingDuplicates[0]
      ? remainingDuplicates[0].duplicateGroups
      : 0;

    if (duplicateCount === 0) {
      console.log("🎉 Verification passed: No duplicates remaining!");
    } else {
      console.log(
        `⚠️  Warning: ${duplicateCount} duplicate groups still exist`,
      );
    }

    // Step 4: Add unique index to prevent future duplicates
    console.log("\n🔧 Adding unique index to prevent future duplicates...");

    try {
      await MachineData.collection.createIndex(
        { machineName: 1, timestamp: 1, status: 1 },
        {
          unique: true,
          name: "unique_machine_timestamp_status",
        },
      );
      console.log("✅ Unique index created successfully");
    } catch (err) {
      console.log("ℹ️  Index note:", err.message);
    }

    // Final stats
    const totalRecords = await MachineData.countDocuments({});
    console.log(`\n📊 Final stats:`);
    console.log(`   Total records in collection: ${totalRecords}`);
    console.log(`   Duplicate records removed: ${totalDeleted}`);
  } catch (error) {
    console.error("❌ Error:", error.message);
    console.error("   Please check your MongoDB URI and connection");
  } finally {
    // Always disconnect
    await mongoose.disconnect();
    console.log("\n👋 Disconnected from MongoDB");
    console.log("\n✨ Script completed!");
  }
}

// Run the function
removeDuplicates();
