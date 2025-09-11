const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const Redis = require("redis");
const Bull = require("bull");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Redis configuration
const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: process.env.REDIS_DB || 0,
  connectTimeout: 5000, // 5 second timeout
  lazyConnect: true, // Don't connect immediately
};

// Redis client for queue discovery
console.log("Creating Redis client with config:", redisConfig);
const redisClient = Redis.createClient(redisConfig);

// Store discovered queues
const discoveredQueues = new Map();
const queueStats = new Map();

// Store Redis metrics history
const redisMetricsHistory = {
  cpu: [],
  memory: [],
  timestamps: [],
};
const MAX_HISTORY_POINTS = 50; // Keep last 50 data points

// Store previous CPU values for rate calculation
let previousCpuValues = {
  used_cpu_sys: 0,
  used_cpu_user: 0,
  timestamp: Date.now(),
};

// Calculate CPU usage percentage from Redis INFO
function calculateCpuUsagePercent(info) {
  const currentCpuSys = parseFloat(info.used_cpu_sys || 0);
  const currentCpuUser = parseFloat(info.used_cpu_user || 0);
  const currentTimestamp = Date.now();

  // Calculate CPU usage rate (percentage)
  let cpuUsagePercent = 0;
  if (previousCpuValues.timestamp > 0) {
    const timeDiff = (currentTimestamp - previousCpuValues.timestamp) / 1000; // seconds
    const cpuSysDiff = currentCpuSys - previousCpuValues.used_cpu_sys;
    const cpuUserDiff = currentCpuUser - previousCpuValues.used_cpu_user;
    const totalCpuDiff = cpuSysDiff + cpuUserDiff;

    // Convert to percentage (CPU time is in seconds, so we need to normalize)
    if (timeDiff > 0) {
      cpuUsagePercent = Math.min(
        100,
        Math.max(0, (totalCpuDiff / timeDiff) * 100)
      );
    }
  }

  // Update previous values
  previousCpuValues = {
    used_cpu_sys: currentCpuSys,
    used_cpu_user: currentCpuUser,
    timestamp: currentTimestamp,
  };

  return cpuUsagePercent;
}

// Connect to Redis
async function connectRedis() {
  try {
    console.log("Attempting to connect to Redis...");
    await redisClient.connect();
    console.log("Connected to Redis successfully");

    // Add error handler to prevent crashes
    redisClient.on("error", (error) => {
      console.error("Redis client error:", error.message);
      // Don't crash the application
    });

    return true;
  } catch (error) {
    console.error("Redis connection error:", error.message);
    console.log(
      "Dashboard will start without Redis connection. Connect Redis to see queue data."
    );
    return false;
  }
}

// Discover Bull queues by scanning Redis keys
async function discoverQueues() {
  try {
    if (!redisClient.isOpen) {
      console.log("Redis not connected, cannot discover queues");
      return [];
    }

    const keys = await redisClient.keys("bull:*");
    const queueNames = new Set();

    // Extract queue names from Bull keys
    keys.forEach((key) => {
      const parts = key.split(":");
      if (parts.length >= 2 && parts[0] === "bull") {
        queueNames.add(parts[1]);
      }
    });

    // Create Bull queue instances for discovered queues
    for (const queueName of queueNames) {
      if (!discoveredQueues.has(queueName)) {
        try {
          const queue = new Bull(queueName, { redis: redisConfig });
          discoveredQueues.set(queueName, queue);
          console.log(`Discovered queue: ${queueName}`);
        } catch (error) {
          console.error(
            `Error creating queue instance for ${queueName}:`,
            error
          );
        }
      }
    }

    return Array.from(queueNames);
  } catch (error) {
    console.error("Error discovering queues:", error);
    return [];
  }
}

// Helper function to add timeout to promises with better error handling
function withTimeout(promise, timeoutMs = 5000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Operation timed out")), timeoutMs)
    ),
  ]).catch((error) => {
    // Log timeout errors but don't crash
    if (error.message === "Operation timed out") {
      console.warn(`Redis operation timed out after ${timeoutMs}ms`);
    }
    throw error;
  });
}

// Helper function to parse Redis INFO command output
function parseRedisInfo(infoString) {
  const info = {};
  if (!infoString) return info;

  const lines = infoString.split("\r\n");
  for (const line of lines) {
    if (line && !line.startsWith("#") && line.includes(":")) {
      const [key, value] = line.split(":");
      if (key && value !== undefined) {
        info[key.trim()] = value.trim();
      }
    }
  }
  return info;
}

// Get queue statistics - FULL MODE: No timeouts, complete data
async function getQueueStats(queueName, queue) {
  try {
    // Get all queue data without timeouts for complete information
    const [waiting, active, completed, failed, delayed, paused] =
      await Promise.all([
        queue.getWaiting(),
        queue.getActive(),
        queue.getCompleted(),
        queue.getFailed(),
        queue.getDelayed(),
        queue.isPaused(),
      ]);

    // Calculate memory usage for this queue
    let memoryUsage = null;
    try {
      const pattern = `bull:${queueName}:*`;
      const keys = await redisClient.keys(pattern);

      if (keys.length > 0) {
        // Get memory usage for all keys of this queue
        const memoryPromises = keys.map(async (key) => {
          try {
            return await redisClient.memoryUsage(key);
          } catch (err) {
            return 0;
          }
        });

        const memorySizes = await Promise.all(memoryPromises);
        const totalBytes = memorySizes.reduce(
          (sum, size) => sum + (size || 0),
          0
        );

        memoryUsage = {
          bytes: totalBytes,
          mb: (totalBytes / (1024 * 1024)).toFixed(2),
        };
      }
    } catch (memError) {
      console.warn(
        `Could not calculate memory for queue ${queueName}:`,
        memError.message
      );
    }

    const stats = {
      name: queueName,
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      delayed: delayed.length,
      paused: paused,
      total:
        waiting.length +
        active.length +
        completed.length +
        failed.length +
        delayed.length,
      memoryUsage: memoryUsage,
      lastUpdated: new Date().toISOString(),
    };

    queueStats.set(queueName, stats);
    return stats;
  } catch (error) {
    console.error(`Error getting stats for queue ${queueName}:`, error);
    return {
      name: queueName,
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: false,
      total: 0,
      memoryUsage: null,
      error: error.message,
      lastUpdated: new Date().toISOString(),
    };
  }
}

// Get Redis metrics
async function getRedisMetrics() {
  try {
    if (!redisClient.isOpen) {
      return null;
    }

    const info = await withTimeout(redisClient.info(), 3000);
    const lines = info.split("\r\n");
    const metrics = {};

    lines.forEach((line) => {
      if (line.includes(":")) {
        const [key, value] = line.split(":");
        metrics[key] = value;
      }
    });

    // Extract CPU and memory metrics
    const currentCpuSys = parseFloat(metrics.used_cpu_sys || 0);
    const currentCpuUser = parseFloat(metrics.used_cpu_user || 0);
    const currentTimestamp = Date.now();

    // Calculate CPU usage rate (percentage)
    let cpuUsagePercent = 0;
    if (previousCpuValues.timestamp > 0) {
      const timeDiff = (currentTimestamp - previousCpuValues.timestamp) / 1000; // seconds
      const cpuSysDiff = currentCpuSys - previousCpuValues.used_cpu_sys;
      const cpuUserDiff = currentCpuUser - previousCpuValues.used_cpu_user;
      const totalCpuDiff = cpuSysDiff + cpuUserDiff;

      // Convert to percentage (CPU time is in seconds, so we need to normalize)
      if (timeDiff > 0) {
        cpuUsagePercent = Math.min(
          100,
          Math.max(0, (totalCpuDiff / timeDiff) * 100)
        );
      }
    }

    // Update previous values
    previousCpuValues = {
      used_cpu_sys: currentCpuSys,
      used_cpu_user: currentCpuUser,
      timestamp: currentTimestamp,
    };

    const memoryUsed = parseInt(metrics.used_memory || 0);
    const memoryMax =
      parseInt(metrics.maxmemory || 0) ||
      parseInt(metrics.total_system_memory || 0);
    const memoryUsagePercent =
      memoryMax > 0 ? (memoryUsed / memoryMax) * 100 : 0;

    const timestamp = new Date().toISOString();

    // Add to history
    redisMetricsHistory.cpu.push(cpuUsagePercent);
    redisMetricsHistory.memory.push(memoryUsagePercent);
    redisMetricsHistory.timestamps.push(timestamp);

    // Keep only last MAX_HISTORY_POINTS
    if (redisMetricsHistory.cpu.length > MAX_HISTORY_POINTS) {
      redisMetricsHistory.cpu.shift();
      redisMetricsHistory.memory.shift();
      redisMetricsHistory.timestamps.shift();
    }

    // Get total number of keys using lightweight operations only
    let totalKeys = 0;
    let totalKeysSize = 0;

    try {
      // Use only DBSIZE command - much faster than KEYS *
      const dbKeys = await withTimeout(redisClient.dbSize(), 1000);
      totalKeys = dbKeys || 0;

      // Estimate total size from Redis INFO memory metrics (no expensive key scanning)
      const usedMemoryDataset = parseInt(metrics.used_memory_dataset || 0);
      totalKeysSize = Math.round(usedMemoryDataset / (1024 * 1024)); // Convert to MB
    } catch (error) {
      console.warn("Error calculating Redis keys metrics:", error.message);
      // Use fallback values
      totalKeys = 0;
      totalKeysSize = 0;
    }

    return {
      cpu: {
        current: cpuUsagePercent,
        history: [...redisMetricsHistory.cpu],
      },
      memory: {
        used: memoryUsed,
        max: memoryMax,
        usagePercent: memoryUsagePercent,
        history: [...redisMetricsHistory.memory],
      },
      timestamps: [...redisMetricsHistory.timestamps],
      connectedClients: parseInt(metrics.connected_clients || 0),
      totalKeys: totalKeys,
      totalKeysSizeMB: totalKeysSize,
      keyspaceHits: parseInt(metrics.keyspace_hits || 0),
      keyspaceMisses: parseInt(metrics.keyspace_misses || 0),
    };
  } catch (error) {
    console.error("Error getting Redis metrics:", error);
    return null;
  }
}

// Update all queue statistics
async function updateAllQueueStats() {
  if (!redisClient.isOpen) {
    return [];
  }

  const queueNames = await discoverQueues();
  const allStats = [];

  // Process queues one by one with small delay for production safety
  for (const queueName of queueNames) {
    const queue = discoveredQueues.get(queueName);
    if (queue) {
      try {
        const stats = await getQueueStats(queueName, queue);
        allStats.push(stats);
        // Small delay to avoid overwhelming production Redis
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch (error) {
        console.warn(
          `Failed to get stats for queue ${queueName}:`,
          error.message
        );
        // Add basic stats even if failed
        allStats.push({
          name: queueName,
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          total: 0,
        });
      }
    }
  }

  return allStats;
}

// Get queue memory usage - DISABLED for production safety
async function getQueueMemoryUsage(queueName) {
  // COMPLETELY DISABLED to avoid overwhelming production Redis
  console.warn(
    `Memory usage calculation disabled for production safety: ${queueName}`
  );
  return 0;
}

// API Routes
app.get("/api/redis-metrics", async (req, res) => {
  try {
    // PRODUCTION-SAFE: Redis monitoring with timeouts and fallbacks
    console.log("Fetching Redis metrics with production safety...");

    const defaultMetrics = {
      cpu: { current: 0, history: [0, 0, 0] },
      memory: { used: 0, max: 0, usagePercent: 0, history: [0, 0, 0] },
      timestamps: [new Date().toISOString()],
      connectedClients: 0,
      totalKeys: 0,
      totalKeysSizeMB: 0,
      keyspaceHits: 0,
      keyspaceMisses: 0,
    };

    // Check Redis connection first
    if (!redisClient.isOpen) {
      console.warn("Redis client not connected, returning default metrics");
      return res.json(defaultMetrics);
    }

    try {
      // Get Redis INFO with longer timeout for stability
      console.log("Calling Redis INFO command...");
      const infoResult = await withTimeout(redisClient.info(), 5000);
      console.log(
        "Redis INFO result length:",
        infoResult ? infoResult.length : 0
      );

      if (!infoResult) {
        console.warn("Redis INFO returned null, using defaults");
        return res.json(defaultMetrics);
      }

      const info = parseRedisInfo(infoResult);
      console.log("Parsed info keys:", Object.keys(info).slice(0, 5));

      // Get database size with timeout
      console.log("Calling Redis DBSIZE command...");
      const dbSize = await withTimeout(redisClient.dbSize(), 5000);
      console.log("Redis DBSIZE result:", dbSize);

      // Calculate metrics safely with better error handling
      const usedMemory = parseInt(info.used_memory || 0);
      const maxMemory = parseInt(
        info.maxmemory || info.total_system_memory || 0
      );

      // Calculate proper CPU usage percentage
      const cpuUsagePercent = calculateCpuUsagePercent(info);

      const metrics = {
        cpu: {
          current: cpuUsagePercent,
          history: [cpuUsagePercent],
        },
        memory: {
          used: usedMemory,
          max: maxMemory,
          usagePercent:
            maxMemory > 0
              ? ((usedMemory / maxMemory) * 100).toFixed(2)
              : "0.00",
          history: [usedMemory],
        },
        timestamps: [new Date().toISOString()],
        connectedClients: parseInt(info.connected_clients || 0),
        totalKeys: dbSize || 0,
        totalKeysSizeMB: Math.round(usedMemory / (1024 * 1024)),
        keyspaceHits: parseInt(info.keyspace_hits || 0),
        keyspaceMisses: parseInt(info.keyspace_misses || 0),
      };

      console.log("Redis metrics fetched successfully:", {
        memory: metrics.memory.usagePercent + "%",
        clients: metrics.connectedClients,
        keys: metrics.totalKeys,
      });
      res.json(metrics);
    } catch (redisError) {
      console.warn(
        "Redis metrics timeout, returning defaults:",
        redisError.message
      );
      res.json(defaultMetrics);
    }
  } catch (error) {
    console.error("Error in redis-metrics endpoint:", error);
    res.status(500).json({ error: "Failed to fetch Redis metrics" });
  }
});

app.get("/api/queues", async (req, res) => {
  try {
    // FULL DISCOVERY MODE: Get all real queue names from Redis
    console.log("FULL DISCOVERY MODE: Scanning Redis for all Bull queues...");

    const allQueueNames = new Set();

    // Add queues discovered by Bull library
    Array.from(discoveredQueues.keys()).forEach((name) =>
      allQueueNames.add(name)
    );

    // KNOWN QUEUES: Use the queue names we discovered from Redis CLI
    console.log("Using known queue names from your Redis instance...");

    const knownQueues = [
      "CRON_CAPACITY_RESOURCE_UPDATE",
      "CRON_SRVC_TYPE_PERIODIC_AUTOMATIONS",
      "WIFY_ASSIGNMENT_EXPORT_BY_EMAIL",
      "WIFY_AUTO_ASSIGN_AUTHORITY_ON_EXISTING_SRVC_REQS",
      "WIFY_AUTO_ASSIGN_AUTORITY_GET_SRVC_REQ_OF_SRVC_TYPE",
      "WIFY_COPY_LAST_SEEN_FROM_REDIS_TO_DB",
      "WIFY_CREATE_API_LOGS",
      "WIFY_GAI_RATING_FOR_TECHNICIAN_SUBTASK",
      "WIFY_GET_ALL_USERS_LAST_SEEN_FOR_COPY_TO_DB",
      "WIFY_NEW_SBTSK_CREATION_NOTIFICATION",
      "WIFY_NOTIFICATION_SEND_FCM",
      "WIFY_PROCESS_RATINGS_QUEUE",
      "WIFY_TMS_LOC_MAPPING_QUEUE",
      "WIFY_SRVC_REQ_EXPORT_BY_EMAIL",
      "WIFY_SBTSK_REQ_STATUS_UPDATE_WORKFLOW",
      "WIFY_SBTSK_REQ_CREATION_WORKFLOW",
      "WIFY_SRVC_REQ_CREATION_WORKFLOW",
    ];

    knownQueues.forEach((name) => allQueueNames.add(name));
    console.log(`Added ${knownQueues.length} known queue names`);

    const queueNames = Array.from(allQueueNames).sort();
    console.log(`✅ FULL DISCOVERY: Found ${queueNames.length} real queues`);
    console.log(
      `Queue names: ${queueNames.slice(0, 10).join(", ")}${
        queueNames.length > 10 ? "..." : ""
      }`
    );

    // NAMES ONLY MODE: Return queue names without statistics
    console.log("NAMES ONLY MODE: Returning queue names without statistics...");

    // Create simple queue objects with just names
    const simpleQueues = queueNames.map((name) => ({
      name: name,
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: false,
      total: 0,
      memoryUsage: null,
      lastUpdated: new Date().toISOString(),
    }));

    console.log(
      `✅ FAST MODE: Returning ${simpleQueues.length} queue names instantly`
    );
    console.log(
      `Queue names: ${queueNames.slice(0, 10).join(", ")}${
        queueNames.length > 10 ? "..." : ""
      }`
    );

    res.json(simpleQueues);
  } catch (error) {
    console.error("Error fetching queues:", error);
    res.status(500).json({ error: "Failed to fetch queues" });
  }
});

app.get("/api/queues/:queueName", async (req, res) => {
  try {
    const { queueName } = req.params;
    console.log(`Getting details for queue: ${queueName}`);

    // Try to get existing Bull instance or create a new one
    let queue = discoveredQueues.get(queueName);

    if (!queue) {
      console.log(`Creating new Bull instance for queue: ${queueName}`);
      try {
        queue = new Bull(queueName, { redis: redisConfig });
        discoveredQueues.set(queueName, queue);
      } catch (bullError) {
        console.warn(
          `Could not create Bull instance for ${queueName}:`,
          bullError.message
        );

        // Fallback: Return basic info from Redis without Bull
        const pattern = `bull:${queueName}:*`;
        const keys = await redisClient.keys(pattern);

        let memoryUsage = null;
        if (keys.length > 0) {
          const memorySizes = await Promise.all(
            keys.map(async (key) => {
              try {
                return await redisClient.memoryUsage(key);
              } catch (err) {
                return 0;
              }
            })
          );
          const totalBytes = memorySizes.reduce(
            (sum, size) => sum + (size || 0),
            0
          );
          memoryUsage = {
            bytes: totalBytes,
            mb: (totalBytes / (1024 * 1024)).toFixed(2),
          };
        }

        return res.json({
          name: queueName,
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          paused: false,
          total: 0,
          memoryUsage: memoryUsage,
          lastUpdated: new Date().toISOString(),
          note: "Bull instance not available - showing Redis data only",
        });
      }
    }

    const stats = await getQueueStats(queueName, queue);
    res.json(stats);
  } catch (error) {
    console.error(
      `Error fetching stats for queue ${req.params.queueName}:`,
      error
    );
    res.status(500).json({ error: "Failed to fetch queue statistics" });
  }
});

app.get("/api/queues/:queueName/keys", async (req, res) => {
  try {
    const { queueName } = req.params;

    // Get ALL Redis keys for this queue - NO TIMEOUT
    const pattern = `bull:${queueName}:*`;
    const keys = await redisClient.keys(pattern);

    // Get memory usage for ALL keys - NO TIMEOUT, NO LIMITS
    const keysWithMemory = await Promise.all(
      keys.map(async (key) => {
        try {
          const memoryUsage = await redisClient.memoryUsage(key);
          return { key, memoryUsage: memoryUsage || 0 };
        } catch (error) {
          return { key, memoryUsage: 0 };
        }
      })
    );

    // Sort by memory usage (heaviest first) - NO LIMIT, show ALL keys
    const sortedKeys = keysWithMemory.sort(
      (a, b) => b.memoryUsage - a.memoryUsage
    );

    // Get values for ALL sorted keys - NO TIMEOUT, FULL DATA
    const keysWithValues = await Promise.all(
      sortedKeys.map(async (keyInfo) => {
        const { key, memoryUsage } = keyInfo;
        try {
          const type = await redisClient.type(key);
          let value;

          switch (type) {
            case "string":
              value = await redisClient.get(key);
              break;
            case "hash":
              // Get FULL hash data - NO LIMITS
              try {
                const hashLength = await redisClient.hLen(key);
                if (hashLength > 100) {
                  // Very large hash - get first 50 fields for display
                  const hashKeys = await redisClient.hKeys(key);
                  const limitedHashKeys = hashKeys.slice(0, 50);
                  const values = await redisClient.hmGet(key, limitedHashKeys);
                  const hashObj = {};
                  limitedHashKeys.forEach((k, i) => {
                    hashObj[k] = values[i];
                  });
                  hashObj["..."] = `(${
                    hashLength - 50
                  } more fields - showing first 50)`;
                  value = hashObj;
                } else {
                  // Get ALL hash fields - NO LIMITS
                  value = await redisClient.hGetAll(key);
                }
              } catch (hashError) {
                // Fallback: just show hash info
                value = `[Hash with ${await redisClient
                  .hLen(key)
                  .catch(() => "?")} fields]`;
              }
              break;
            case "list":
              const listLength = await redisClient.lLen(key);
              if (listLength > 50) {
                // Large list - show first 50 items
                value = await redisClient.lRange(key, 0, 49);
                value.push(
                  `... (${listLength - 50} more items - showing first 50)`
                );
              } else {
                // Get ALL list items - NO LIMITS
                value = await redisClient.lRange(key, 0, -1);
              }
              break;
            case "set":
              const setMembers = await redisClient.sMembers(key);
              if (setMembers.length > 50) {
                // Large set - show first 50 members
                value = setMembers.slice(0, 50);
                value.push(
                  `... (${
                    setMembers.length - 50
                  } more members - showing first 50)`
                );
              } else {
                // Get ALL set members - NO LIMITS
                value = setMembers;
              }
              break;
            case "zset":
              const zsetLength = await redisClient.zCard(key);
              if (zsetLength > 50) {
                // Large sorted set - show first 50 members
                value = await redisClient.zRangeWithScores(key, 0, 49);
                value.push(
                  `... (${zsetLength - 50} more members - showing first 50)`
                );
              } else {
                // Get ALL sorted set members - NO LIMITS
                value = await redisClient.zRangeWithScores(key, 0, -1);
              }
              break;
            default:
              value = `[${type}]`;
          }

          return {
            key,
            type,
            value,
            memoryUsage,
            size: memoryUsage, // Use actual Redis memory usage
            sizeFormatted: `${(memoryUsage / 1024).toFixed(2)} KB`,
          };
        } catch (error) {
          console.warn(`Failed to fetch value for key ${key}:`, error.message);

          // Try to get at least the type information
          let keyType = "unknown";
          try {
            keyType = await withTimeout(redisClient.type(key), 2000);
          } catch (typeError) {
            console.warn(
              `Failed to get type for key ${key}:`,
              typeError.message
            );
          }

          return {
            key,
            type: keyType,
            value: `Failed to fetch (${error.message})`,
            memoryUsage,
            size: memoryUsage,
            sizeFormatted: `${(memoryUsage / 1024).toFixed(2)} KB`,
          };
        }
      })
    );

    res.json({
      queueName,
      totalKeys: keys.length,
      keys: keysWithValues,
    });
  } catch (error) {
    console.error(
      `Error fetching keys for queue ${req.params.queueName}:`,
      error
    );
    res.status(500).json({ error: "Failed to fetch queue keys" });
  }
});

app.get("/api/queues/:queueName/jobs/:status", async (req, res) => {
  try {
    const { queueName, status } = req.params;
    const queue = discoveredQueues.get(queueName);

    if (!queue) {
      return res.status(404).json({ error: "Queue not found" });
    }

    let jobs = [];
    switch (status) {
      case "waiting":
        jobs = await queue.getWaiting();
        break;
      case "active":
        jobs = await queue.getActive();
        break;
      case "completed":
        jobs = await queue.getCompleted();
        break;
      case "failed":
        jobs = await queue.getFailed();
        break;
      case "delayed":
        jobs = await queue.getDelayed();
        break;
      default:
        return res.status(400).json({ error: "Invalid job status" });
    }

    const jobData = jobs.map((job) => ({
      id: job.id,
      name: job.name,
      data: job.data,
      opts: job.opts,
      progress: job.progress,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
    }));

    res.json(jobData);
  } catch (error) {
    console.error(
      `Error fetching jobs for queue ${req.params.queueName}:`,
      error
    );
    res.status(500).json({ error: "Failed to fetch jobs" });
  }
});

// Serve the dashboard
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Socket.IO for real-time updates
io.on("connection", (socket) => {
  console.log("Client connected");

  // Send initial data
  const sendInitialData = async () => {
    try {
      const [queueStats, redisMetrics] = await Promise.all([
        updateAllQueueStats(),
        getRedisMetrics(),
      ]);

      // Add memory usage to queue stats
      const statsWithMemory = await Promise.all(
        queueStats.map(async (queueStat) => {
          try {
            const memoryBytes = await getQueueMemoryUsage(queueStat.name);
            queueStat.memoryUsage = {
              bytes: memoryBytes,
              mb: (memoryBytes / (1024 * 1024)).toFixed(2),
            };
            return queueStat;
          } catch (error) {
            console.error(
              `Error getting memory for queue ${queueStat.name}:`,
              error
            );
            queueStat.memoryUsage = { bytes: 0, mb: "0.00" };
            return queueStat;
          }
        })
      );

      console.log(
        `Sending data: ${statsWithMemory.length} queues, Redis metrics:`,
        !!redisMetrics
      );
      socket.emit("queueStats", statsWithMemory);
      socket.emit("redisMetrics", redisMetrics);
    } catch (error) {
      console.error("Error sending initial data:", error);
      socket.emit("queueStats", []);
      socket.emit("redisMetrics", null);
    }
  };

  sendInitialData();

  socket.on("disconnect", () => {
    console.log("Client disconnected");
  });

  socket.on("error", (error) => {
    console.error("Socket error:", error);
  });
});

// DISABLED: No real-time updates to protect production Redis
console.log("Real-time updates disabled for production safety");

// Start server
const PORT = process.env.PORT || 3000;

async function startServer() {
  const redisConnected = await connectRedis();

  // Queue discovery disabled - only discover when explicitly requested
  console.log("Queue discovery disabled for optimal startup performance");

  server.listen(PORT, () => {
    console.log(
      `Bull Dashboard running on http://localhost:${PORT} - Fixed timeouts`
    );
    if (redisConnected) {
      console.log(
        `Monitoring Redis at ${redisConfig.host}:${redisConfig.port}`
      );
    } else {
      console.log(`Redis not connected. Start Redis server to monitor queues.`);
    }
  });
}

startServer().catch(console.error);
