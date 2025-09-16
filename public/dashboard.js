class BullDashboard {
  constructor() {
    this.socket = null;
    this.selectedQueue = null;
    this.selectedJobStatus = "waiting";
    this.cpuChart = null;
    this.memoryChart = null;
    this.currentPage = "redis";
    this.queuesLoaded = false; // Track if queues have been loaded

    this.init();
  }

  init() {
    this.connectSocket();
    this.setupEventListeners();
    this.setupPageSwitching();
    this.loadInitialData();
    this.initCharts();
    this.initModal();
  }

  connectSocket() {
    this.socket = io();

    this.socket.on("connect", () => {
      console.log("Connected to server");
      this.updateConnectionStatus(true);
    });

    this.socket.on("disconnect", () => {
      console.log("Disconnected from server");
      this.updateConnectionStatus(false);
    });

    this.socket.on("queueStats", (stats) => {
      // Only update queue stats if we're on the queues page and have loaded queues
      if (this.currentPage === "queues" && this.queuesLoaded) {
        console.log("Received queue stats:", stats.length, "queues");
        try {
          this.updateDashboard(stats);
        } catch (error) {
          console.error("Error updating dashboard:", error);
        }
      } else {
        console.log(
          "Ignoring queue stats - not on queues page or not loaded yet"
        );
      }
    });

    this.socket.on("redisMetrics", (metrics) => {
      console.log("Received Redis metrics:", !!metrics);
      try {
        this.updateRedisMetrics(metrics);
      } catch (error) {
        console.error("Error updating Redis metrics:", error);
      }
    });

    // Handle progressive queue loading
    this.socket.on("queueProcessingProgress", (progressData) => {
      if (this.currentPage === "queues") {
        console.log(
          `Queue processing progress: ${progressData.processedQueues}/${progressData.totalQueues} (${progressData.progress}%)`
        );
        this.updateProgressiveLoading(progressData);
      }
    });

    this.socket.on("queueProcessingComplete", (completionData) => {
      if (this.currentPage === "queues") {
        console.log(
          "Queue processing completed:",
          completionData.queues.length,
          "queues"
        );
        this.completeProgressiveLoading(completionData);
      }
    });

    this.socket.on("connect_error", (error) => {
      console.error("Connection error:", error);
    });

    this.socket.on("error", (error) => {
      console.error("Socket error:", error);
    });
  }

  updateConnectionStatus(connected) {
    const statusDot = document.getElementById("connection-status");
    const statusText = document.getElementById("connection-text");

    if (connected) {
      statusDot.className = "status-dot online";
      statusText.textContent = "Connected";
    } else {
      statusDot.className = "status-dot offline";
      statusText.textContent = "Disconnected";
    }
  }

  setupEventListeners() {
    // Job status tabs
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        this.selectJobStatus(e.target.dataset.status);
      });
    });

    // Refresh button
    const refreshBtn = document.getElementById("refresh-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        this.refreshData();
      });
    }
  }

  setupPageSwitching() {
    // Page navigation buttons
    const redisTab = document.getElementById("redis-tab");
    const queuesTab = document.getElementById("queues-tab");

    if (redisTab) {
      redisTab.addEventListener("click", () => {
        this.switchToPage("redis");
      });
    }

    if (queuesTab) {
      queuesTab.addEventListener("click", () => {
        this.switchToPage("queues");
      });
    }

    // Initialize with Redis page active
    this.switchToPage("redis");
  }

  switchToPage(page) {
    this.currentPage = page;
    console.log("Switching to page:", page);

    // Update navigation buttons
    document.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.classList.remove("active");
    });

    // Update page visibility
    document.querySelectorAll(".page").forEach((pageEl) => {
      pageEl.classList.remove("active");
      console.log("Removed active from page:", pageEl.id);
    });

    if (page === "redis") {
      document.getElementById("redis-tab")?.classList.add("active");
      const redisPage = document.getElementById("redis-page");
      redisPage?.classList.add("active");
      console.log(
        "Redis page active:",
        redisPage?.classList.contains("active")
      );
      // Load Redis data if not already loaded
      this.loadRedisMetrics();
    } else if (page === "queues") {
      document.getElementById("queues-tab")?.classList.add("active");
      const queuesPage = document.getElementById("queues-page");
      queuesPage?.classList.add("active");
      console.log(
        "Queues page active:",
        queuesPage?.classList.contains("active")
      );
      // Only load queue data if not already loaded
      if (!this.queuesLoaded) {
        this.showQueuesLoading();
        this.loadQueues();
      }
    }
  }

  async loadInitialData() {
    // Only load Redis metrics by default since that's the default page
    this.loadRedisMetrics();
  }

  showQueuesLoading() {
    // Show loading state in queues page
    const queuesGrid = document.getElementById("queues-grid");
    // DISABLED: const heaviestQueues = document.getElementById("heaviest-queues-list");

    if (queuesGrid) {
      queuesGrid.innerHTML = `
        <div class="loading-container">
          <div class="loading-spinner">🔄</div>
          <p>Loading queue data for the first time...</p>
        </div>
      `;
    }

    // DISABLED: Heaviest queues loading
    /*
    if (heaviestQueues) {
      heaviestQueues.innerHTML = `
        <div class="loading-container">
          <div class="loading-spinner">🔄</div>
          <p>Loading heaviest queues...</p>
        </div>
      `;
    }
    */
  }

  showProgressiveLoading() {
    // Show progressive loading state
    const queuesGrid = document.getElementById("queues-grid");
    // DISABLED: const heaviestQueues = document.getElementById("heaviest-queues-list");

    if (queuesGrid) {
      queuesGrid.innerHTML = `
        <div class="progressive-loading-container">
          <div class="loading-spinner">🔄</div>
          <h3>🔍 Discovering Queues...</h3>
          <div class="progress-info">
            <div class="progress-bar">
              <div class="progress-fill" id="progress-fill" style="width: 0%; background: #667eea; height: 20px; border-radius: 10px; transition: width 0.3s ease;"></div>
            </div>
            <div class="progress-text" id="progress-text" style="margin-top: 10px; font-weight: bold;">Initializing...</div>
          </div>
          <div class="queues-preview" id="queues-preview" style="margin-top: 20px;">
            <h4>📋 Recently Processed Queues:</h4>
            <div class="preview-grid" id="preview-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; max-height: 300px; overflow-y: auto;"></div>
          </div>
        </div>
      `;
    }

    // DISABLED: Heaviest queues progressive loading
    /*
    if (heaviestQueues) {
      heaviestQueues.innerHTML = `
        <div class="loading-container">
          <div class="loading-spinner">🔄</div>
          <p>Processing queue memory usage...</p>
        </div>
      `;
    }
    */
  }

  updateProgressiveStatus(data) {
    const progressText = document.getElementById("progress-text");
    if (progressText) {
      progressText.textContent = data.message;
    }
  }

  updateProgressiveLoading(progressData) {
    // Update progress bar
    const progressFill = document.getElementById("progress-fill");
    const progressText = document.getElementById("progress-text");

    if (progressFill) {
      progressFill.style.width = `${progressData.progress}%`;
    }

    if (progressText) {
      progressText.textContent = progressData.message;
    }

    // Add the latest queue to preview
    if (progressData.latestQueue) {
      this.addQueueToPreview(progressData.latestQueue);
    }
  }

  addQueueToPreview(queueData) {
    const previewGrid = document.getElementById("preview-grid");
    if (!previewGrid) return;

    const memoryMB = queueData.memoryUsage?.mb || "0.00";

    const queueCard = document.createElement("div");
    queueCard.className = "queue-card-mini";
    queueCard.style.cssText = `
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 10px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    `;
    queueCard.innerHTML = `
      <div style="font-weight: bold; font-size: 12px; margin-bottom: 5px; color: #2d3748;">${queueData.name}</div>
      <div style="display: flex; justify-content: space-between; font-size: 11px; color: #718096;">
        <span>📊 ${queueData.total}</span>
        <span>💾 ${memoryMB} MB</span>
      </div>
    `;

    // Insert at the beginning to show latest first
    previewGrid.insertBefore(queueCard, previewGrid.firstChild);

    // Keep only the last 15 queues in preview
    while (previewGrid.children.length > 15) {
      previewGrid.removeChild(previewGrid.lastChild);
    }
  }

  completeProgressiveLoading(completionData) {
    console.log("Progressive loading completed, updating dashboard...");

    // Show completion message briefly
    const progressText = document.getElementById("progress-text");
    if (progressText) {
      progressText.textContent = `✅ Completed! Loaded ${completionData.queues.length} queues`;
    }

    // After a short delay, show the full dashboard
    setTimeout(() => {
      this.updateDashboard(completionData.queues);
      this.queuesLoaded = true;
    }, 1500);
  }

  async loadRedisMetrics() {
    try {
      console.log("Loading Redis metrics...");
      const response = await fetch("/api/redis-metrics");
      const metrics = await response.json();
      this.updateRedisMetrics(metrics);
      console.log("Redis metrics loaded successfully");
    } catch (error) {
      console.error("Error loading Redis metrics:", error);
      this.showError("Failed to load Redis metrics");
    }
  }

  async loadQueues() {
    try {
      console.log("FULL DISCOVERY: Loading all real queue names from Redis...");

      // Show loading UI
      this.showQueuesLoading();

      const response = await fetch("/api/queues");
      const queueData = await response.json();

      console.log(
        `✅ FULL DISCOVERY: Loaded ${queueData.length} real queue names from Redis`
      );
      console.log(
        `Queue names: ${queueData
          .slice(0, 10)
          .map((q) => q.name)
          .join(", ")}${queueData.length > 10 ? "..." : ""}`
      );

      this.updateDashboard(queueData);
      this.queuesLoaded = true;
    } catch (error) {
      console.error("Error loading queue data:", error);
      this.showError("Failed to load queue data");
    }
  }

  async refreshData() {
    const refreshBtn = document.getElementById("refresh-btn");

    // Add loading state to button
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.innerHTML = "🔄 Refreshing...";
      refreshBtn.style.opacity = "0.7";
    }

    try {
      // Refresh data based on current page
      if (this.currentPage === "redis") {
        this.loadRedisMetrics();
      } else if (this.currentPage === "queues" && this.queuesLoaded) {
        console.log("Refreshing queue data...");
        const response = await fetch("/api/queues");
        const stats = await response.json();
        this.updateDashboard(stats);
      }

      // Show success feedback
      if (refreshBtn) {
        refreshBtn.innerHTML = "✅ Refreshed";
        setTimeout(() => {
          refreshBtn.innerHTML = "🔄 Refresh";
        }, 1500);
      }
    } catch (error) {
      console.error("Error refreshing data:", error);
      this.showError("Failed to refresh queue data");

      // Show error feedback
      if (refreshBtn) {
        refreshBtn.innerHTML = "❌ Error";
        setTimeout(() => {
          refreshBtn.innerHTML = "🔄 Refresh";
        }, 2000);
      }
    } finally {
      // Reset button state
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.style.opacity = "1";
      }
    }
  }

  updateDashboard(stats) {
    this.updateOverallStats(stats);
    // DISABLED: this.updateHeaviestQueues(stats);
    this.updateQueuesGrid(stats);
  }

  updateOverallStats(stats) {
    const totalQueues = stats.length;
    const totalJobs = stats.reduce((sum, queue) => sum + queue.total, 0);
    const activeJobs = stats.reduce((sum, queue) => sum + queue.active, 0);
    const failedJobs = stats.reduce((sum, queue) => sum + queue.failed, 0);

    document.getElementById("total-queues").textContent = totalQueues;
    document.getElementById("total-jobs").textContent = totalJobs;
    document.getElementById("active-jobs").textContent = activeJobs;
    document.getElementById("failed-jobs").textContent = failedJobs;
  }

  updateHeaviestQueues(stats) {
    const heaviestQueuesList = document.getElementById("heaviest-queues-list");

    if (!stats || stats.length === 0) {
      heaviestQueuesList.innerHTML =
        '<div class="loading">No queue data available.</div>';
      return;
    }

    // Sort queues by memory usage (heaviest first) and take top 5
    const sortedByMemory = stats
      .filter(
        (queue) =>
          queue.memoryUsage &&
          queue.memoryUsage.mb &&
          parseFloat(queue.memoryUsage.mb) >= 0
      )
      .sort((a, b) => {
        const memoryA = parseFloat(a.memoryUsage.mb) || 0;
        const memoryB = parseFloat(b.memoryUsage.mb) || 0;
        return memoryB - memoryA;
      })
      .slice(0, 5);

    if (sortedByMemory.length === 0) {
      // Check if we're in emergency mode (all memory usage is null)
      const hasAnyMemoryData = stats.some(
        (queue) => queue.memoryUsage && queue.memoryUsage.mb
      );

      if (!hasAnyMemoryData) {
        heaviestQueuesList.innerHTML = `
          <div class="emergency-mode-message">
            <h3>🚨 Emergency Mode Active</h3>
            <p>Memory usage calculation disabled to protect production Redis.</p>
            <p>Showing queue names only. Click any queue card below to view Redis keys.</p>
          </div>
        `;
      } else {
        heaviestQueuesList.innerHTML =
          '<div class="loading">No memory usage data available.</div>';
      }
      return;
    }

    heaviestQueuesList.innerHTML = sortedByMemory
      .map((queue, index) => this.createHeaviestQueueItem(queue, index + 1))
      .join("");

    // Add click event listeners to heaviest queue cards
    heaviestQueuesList
      .querySelectorAll(".heaviest-queue-item")
      .forEach((card) => {
        card.addEventListener("click", () => {
          const queueName = card.getAttribute("data-queue-name");
          this.showQueueKeysModal(queueName);
        });
      });
  }

  createHeaviestQueueItem(queue, rank) {
    const memoryMB = queue.memoryUsage ? parseFloat(queue.memoryUsage.mb) : 0;
    const memoryBytes = queue.memoryUsage
      ? parseInt(queue.memoryUsage.bytes)
      : 0;

    return `
      <div class="heaviest-queue-item" data-queue-name="${this.escapeHtml(
        queue.name
      )}"
        <div class="heaviest-queue-info">
          <div class="heaviest-queue-name">
            <span class="heaviest-queue-rank">#${rank}</span>
            ${this.escapeHtml(queue.name)}
          </div>
          <div class="heaviest-queue-details">
            <span>Jobs: ${queue.total}</span>
            <span>Active: ${queue.active}</span>
            <span>Failed: ${queue.failed}</span>
          </div>
        </div>
        <div class="heaviest-queue-memory">
          <div>${memoryMB} MB</div>
          <div style="font-size: 0.7rem; opacity: 0.8;">
            ${memoryBytes.toLocaleString()} bytes
          </div>
        </div>
      </div>
    `;
  }

  updateQueuesGrid(stats) {
    const grid = document.getElementById("queues-grid");

    if (stats.length === 0) {
      grid.innerHTML =
        '<div class="loading">No queues found. Make sure your Bull queues are running.</div>';
      return;
    }

    // Sort queues by memory usage (heaviest first)
    const sortedStats = stats.sort((a, b) => {
      const memoryA = parseFloat(a.memoryUsage?.mb) || 0;
      const memoryB = parseFloat(b.memoryUsage?.mb) || 0;
      return memoryB - memoryA; // Descending order (heaviest first)
    });

    // Initialize lazy loading
    this.initializeLazyLoading(grid, sortedStats);
  }

  initializeLazyLoading(grid, allQueues) {
    // Clear the grid
    grid.innerHTML = "";

    // Store all queues for lazy loading
    this.allQueues = allQueues;
    this.currentLoadedCount = 0;
    this.cardsPerRow = 4; // 4 cards per row
    this.rowsToLoad = 5; // Load 5 rows at a time
    this.batchSize = this.cardsPerRow * this.rowsToLoad; // 20 cards per batch
    this.isLoading = false;
    this.autoLoadTimer = null;

    // Create container for queue cards
    const cardsContainer = document.createElement("div");
    cardsContainer.className = "queue-cards-container";
    cardsContainer.style.display = "grid";
    cardsContainer.style.gridTemplateColumns = "repeat(3, 1fr)";
    cardsContainer.style.gap = "1rem";
    grid.appendChild(cardsContainer);

    // Create loading indicator
    const loadingIndicator = document.createElement("div");
    loadingIndicator.className = "auto-loading-indicator";
    loadingIndicator.style.textAlign = "center";
    loadingIndicator.style.marginTop = "2rem";
    loadingIndicator.style.display = "none";
    loadingIndicator.innerHTML = `
      <div class="loading-spinner">🔄</div>
      <p>Auto-loading next batch in <span id="countdown">5</span> seconds...</p>
    `;
    grid.appendChild(loadingIndicator);

    // Load initial batch
    this.loadNextBatch();

    // Start auto-loading timer
    this.startAutoLoadTimer();
  }

  loadNextBatch() {
    if (this.isLoading || this.currentLoadedCount >= this.allQueues.length) {
      return;
    }

    this.isLoading = true;
    const cardsContainer = document.querySelector(".queue-cards-container");
    const loadingIndicator = document.querySelector(".auto-loading-indicator");

    // Show loading indicator
    if (loadingIndicator) {
      loadingIndicator.style.display = "block";
    }

    // Calculate batch to load
    const startIndex = this.currentLoadedCount;
    const endIndex = Math.min(
      startIndex + this.batchSize,
      this.allQueues.length
    );
    const batchQueues = this.allQueues.slice(startIndex, endIndex);

    // Simulate loading delay for better UX
    setTimeout(() => {
      // Create and append new cards
      batchQueues.forEach((queue) => {
        console.log("Creating card for queue:", queue.name);
        const cardHTML = this.createQueueCard(queue);
        console.log("Generated HTML:", cardHTML.substring(0, 100) + "...");

        const cardElement = document.createElement("div");
        cardElement.innerHTML = cardHTML;
        const card = cardElement.firstElementChild;

        console.log("Card element:", card);
        console.log("Card classes:", card.className);

        // Add click listener
        card.addEventListener("click", () => {
          this.selectQueue(card.dataset.queueName);
        });

        cardsContainer.appendChild(card);
        console.log("Card appended to container");
      });

      // Update loaded count
      this.currentLoadedCount = endIndex;

      // Hide loading indicator
      if (loadingIndicator) {
        loadingIndicator.style.display = "none";
      }

      this.isLoading = false;

      // Continue auto-loading if there are more queues
      if (this.currentLoadedCount < this.allQueues.length) {
        this.startAutoLoadTimer();
      }
    }, 300); // Small delay to show loading state
  }

  startAutoLoadTimer() {
    // Clear any existing timer
    if (this.autoLoadTimer) {
      clearInterval(this.autoLoadTimer);
    }

    // Don't start timer if all queues are loaded
    if (this.currentLoadedCount >= this.allQueues.length) {
      return;
    }

    const loadingIndicator = document.querySelector(".auto-loading-indicator");
    const countdownElement = document.getElementById("countdown");

    if (loadingIndicator) {
      loadingIndicator.style.display = "block";
    }

    let countdown = 5;
    if (countdownElement) {
      countdownElement.textContent = countdown;
    }

    this.autoLoadTimer = setInterval(() => {
      countdown--;
      if (countdownElement) {
        countdownElement.textContent = countdown;
      }

      if (countdown <= 0) {
        clearInterval(this.autoLoadTimer);
        this.loadNextBatch();
      }
    }, 1000);
  }

  stopAutoLoadTimer() {
    if (this.autoLoadTimer) {
      clearInterval(this.autoLoadTimer);
      this.autoLoadTimer = null;
    }

    const loadingIndicator = document.querySelector(".auto-loading-indicator");
    if (loadingIndicator) {
      loadingIndicator.style.display = "none";
    }
  }

  createQueueCard(queue) {
    // Calculate memory usage display
    const memoryMB = queue.memoryUsage?.mb || "0";
    const memoryBytes = queue.memoryUsage?.bytes || 0;

    // Format memory display
    const memoryMBFormatted = parseFloat(memoryMB).toFixed(0);
    const memoryBytesFormatted = parseInt(memoryBytes).toLocaleString();

    // Determine if queue is running (has any jobs)
    const isRunning =
      queue.waiting +
        queue.active +
        queue.completed +
        queue.failed +
        queue.delayed >
      0;
    const runningStatus = isRunning ? "🟢 Running" : "⚪ Running";

    return `
      <div class="queue-card-detailed" data-queue-name="${
        queue.name
      }" style="background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; cursor: pointer; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); min-height: 200px; display: flex; flex-direction: column; gap: 12px; color: #2d3748;">
        <div class="queue-card-title" style="font-size: 14px; font-weight: 600; color: #2d3748; margin-bottom: 12px; text-align: left;">
          ${this.escapeHtml(queue.name)}
        </div>

        <div class="queue-stats-row" style="display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin-bottom: 8px;">
          <div class="stat-col" style="text-align: center;">
            <div class="stat-label" style="font-size: 10px; font-weight: 500; color: #718096; text-transform: uppercase; margin-bottom: 2px;">WAITING</div>
            <div class="stat-value" style="font-size: 11px; color: #4a5568; font-weight: 500;">${
              queue.waiting || 0
            }</div>
          </div>
          <div class="stat-col" style="text-align: center;">
            <div class="stat-label" style="font-size: 10px; font-weight: 500; color: #718096; text-transform: uppercase; margin-bottom: 2px;">ACTIVE</div>
            <div class="stat-value" style="font-size: 11px; color: #4a5568; font-weight: 500;">${
              queue.active || 0
            }</div>
          </div>
          <div class="stat-col" style="text-align: center;">
            <div class="stat-label" style="font-size: 10px; font-weight: 500; color: #718096; text-transform: uppercase; margin-bottom: 2px;">COMPLETED</div>
            <div class="stat-value" style="font-size: 11px; color: #4a5568; font-weight: 500;">${
              queue.completed || 0
            }</div>
          </div>
          <div class="stat-col" style="text-align: center;">
            <div class="stat-label" style="font-size: 10px; font-weight: 500; color: #718096; text-transform: uppercase; margin-bottom: 2px;">FAILED</div>
            <div class="stat-value" style="font-size: 11px; color: #4a5568; font-weight: 500;">${
              queue.failed || 0
            }</div>
          </div>
          <div class="stat-col" style="text-align: center;">
            <div class="stat-label" style="font-size: 10px; font-weight: 500; color: #718096; text-transform: uppercase; margin-bottom: 2px;">DELAYED</div>
            <div class="stat-value" style="font-size: 11px; color: #4a5568; font-weight: 500;">${
              queue.delayed || 0
            }</div>
          </div>
          <div class="stat-col" style="text-align: center;">
            <div class="stat-label" style="font-size: 10px; font-weight: 500; color: #718096; text-transform: uppercase; margin-bottom: 2px;">TOTAL</div>
            <div class="stat-value" style="font-size: 11px; color: #4a5568; font-weight: 500;">${
              queue.total || 0
            }</div>
          </div>
        </div>

        <div class="queue-stats-row">
          <div class="stat-col">
            <div class="stat-number">${queue.waiting || 0}</div>
          </div>
          <div class="stat-col">
            <div class="stat-number">${queue.active || 0}</div>
          </div>
          <div class="stat-col">
            <div class="stat-number">${queue.completed || 0}</div>
          </div>
          <div class="stat-col">
            <div class="stat-number">${queue.failed || 0}</div>
          </div>
          <div class="stat-col">
            <div class="stat-number ${
              queue.delayed > 0 ? "undefined-text" : ""
            }">${queue.delayed > 0 ? "undefined" : queue.delayed || 0}</div>
          </div>
          <div class="stat-col">
            <div class="stat-number">${queue.total || 0}</div>
          </div>
        </div>

        <div class="memory-section">
          <div class="memory-badge">
            <div class="memory-label">MEMORY</div>
            <div class="memory-value">${memoryMBFormatted} MB (${memoryBytesFormatted} bytes)</div>
          </div>
        </div>

        <div class="queue-footer">
          <div class="running-status">${runningStatus}</div>
          <div class="updated-status">Updated: Invalid Date</div>
        </div>
      </div>
    `;
  }

  async selectQueue(queueName) {
    this.selectedQueue = queueName;

    // Show queue details modal with statistics and Redis keys
    this.showQueueDetailsModal(queueName);
  }

  async showQueueDetailsModal(queueName) {
    // Create and show a detailed modal with queue statistics
    const modal = document.createElement("div");
    modal.className = "queue-details-modal";

    // Show loading state first
    modal.innerHTML = `
      <div class="queue-details-modal-content">
        <div class="queue-details-header">
          <h2>Queue Details: ${queueName}</h2>
          <button class="close-modal" onclick="this.parentElement.parentElement.parentElement.remove()">&times;</button>
        </div>
        <div class="queue-details-body">
          <div class="queue-stats-section">
            <h3>📊 Queue Statistics</h3>
            <div class="loading-container">
              <div class="loading-spinner">🔄</div>
              <p>Loading queue statistics...</p>
            </div>
          </div>
          <div class="queue-actions-section">
            <h3>🔧 Actions</h3>
            <button class="action-btn" onclick="document.querySelector('.queue-details-modal').remove(); dashboard.showQueueKeysModal('${queueName}')">
              🔍 View Redis Keys
            </button>
          </div>
        </div>
      </div>
    `;

    // Add modal to DOM first
    document.body.appendChild(modal);

    try {
      // Fetch real queue statistics
      console.log(`Fetching statistics for queue: ${queueName}`);
      const response = await fetch(`/api/queues/${queueName}`);
      const queueStats = await response.json();

      console.log(`Queue stats for ${queueName}:`, queueStats);

      // Update modal with real data
      const statsSection = modal.querySelector(".queue-stats-section");

      statsSection.innerHTML = `
        <h3>📊 Queue Statistics</h3>
        <div class="queue-stats-grid">
          <div class="stat-item">
            <span class="stat-label">Waiting:</span>
            <span class="stat-value">${queueStats.waiting || 0}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Active:</span>
            <span class="stat-value">${queueStats.active || 0}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Completed:</span>
            <span class="stat-value">${queueStats.completed || 0}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Failed:</span>
            <span class="stat-value">${queueStats.failed || 0}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Total:</span>
            <span class="stat-value">${queueStats.total || 0}</span>
          </div>
        </div>
        <div class="stats-note">
          <p>✅ <strong>Real-time data</strong> from Redis and Bull queue</p>
        </div>
      `;
    } catch (error) {
      console.error(`Error fetching queue statistics for ${queueName}:`, error);

      // Show error state
      const statsSection = modal.querySelector(".queue-stats-section");
      statsSection.innerHTML = `
        <h3>📊 Queue Statistics</h3>
        <div class="error-container">
          <p>❌ <strong>Error:</strong> Failed to load queue statistics</p>
          <p>Please try again or check the console for details.</p>
        </div>
      `;
    }

    // Add modal styles
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 1000;
    `;

    document.body.appendChild(modal);

    // Close modal when clicking outside
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.remove();
      }
    });

    // Close modal with Escape key
    const handleEscape = (e) => {
      if (e.key === "Escape") {
        modal.remove();
        document.removeEventListener("keydown", handleEscape);
      }
    };
    document.addEventListener("keydown", handleEscape);
  }

  async showQueueKeysModal(queueName) {
    const modal = document.getElementById("queue-keys-modal");
    const modalQueueName = document.getElementById("modal-queue-name");
    const keysContainer = document.getElementById("keys-container");
    const totalKeysCount = document.getElementById("total-keys-count");
    const showingKeysCount = document.getElementById("showing-keys-count");

    // Show modal and set queue name
    modalQueueName.textContent = queueName;
    modal.style.display = "block";

    // Show loading state
    keysContainer.innerHTML =
      '<div class="loading">Loading Redis keys...</div>';
    totalKeysCount.textContent = "0";
    showingKeysCount.textContent = "0";

    try {
      // Fetch queue keys from server
      const response = await fetch(
        `/api/queues/${encodeURIComponent(queueName)}/keys`
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      // Update summary
      totalKeysCount.textContent = data.totalKeys;
      showingKeysCount.textContent = data.keys.length;

      // Render keys
      if (data.keys.length === 0) {
        keysContainer.innerHTML =
          '<div class="loading">No Redis keys found for this queue.</div>';
      } else {
        keysContainer.innerHTML = data.keys
          .map((keyData) => this.createKeyItem(keyData))
          .join("");
      }
    } catch (error) {
      console.error("Error fetching queue keys:", error);
      keysContainer.innerHTML = `
        <div class="loading" style="color: #e53e3e;">
          Error loading keys: ${error.message}
        </div>
      `;
    }
  }

  createKeyItem(keyData) {
    const valueDisplay = this.formatKeyValue(keyData.value, keyData.type);

    // Use server-provided formatted size or calculate from memory usage
    const sizeDisplay =
      keyData.sizeFormatted ||
      (keyData.memoryUsage > 1024
        ? `${(keyData.memoryUsage / 1024).toFixed(2)} KB`
        : `${keyData.memoryUsage || 0} B`);

    return `
      <div class="key-item">
        <div class="key-header">
          <div class="key-name">${this.escapeHtml(keyData.key)}</div>
          <div class="key-meta">
            <span class="key-type">${keyData.type}</span>
            <span class="key-size">${sizeDisplay}</span>
          </div>
        </div>
        <div class="key-value ${
          keyData.type === "error" ? "error" : ""
        }">${valueDisplay}</div>
      </div>
    `;
  }

  formatKeyValue(value, type) {
    if (type === "error") {
      return this.escapeHtml(value);
    }

    try {
      if (typeof value === "object") {
        return this.escapeHtml(JSON.stringify(value, null, 2));
      } else {
        return this.escapeHtml(String(value));
      }
    } catch (error) {
      return this.escapeHtml(String(value));
    }
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  initModal() {
    const modal = document.getElementById("queue-keys-modal");
    const closeBtn = document.getElementById("close-modal");

    // Close modal when clicking the X button
    closeBtn.addEventListener("click", () => {
      modal.style.display = "none";
    });

    // Close modal when clicking outside the modal content
    modal.addEventListener("click", (event) => {
      if (event.target === modal) {
        modal.style.display = "none";
      }
    });

    // Close modal when pressing Escape key
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && modal.style.display === "block") {
        modal.style.display = "none";
      }
    });
  }

  selectJobStatus(status) {
    this.selectedJobStatus = status;

    // Update tab appearance
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.classList.remove("active");
    });
    document.querySelector(`[data-status="${status}"]`).classList.add("active");

    // Load jobs for this status
    this.loadJobs(this.selectedQueue, status);
  }

  async loadJobs(queueName, status) {
    const container = document.getElementById("jobs-container");
    container.innerHTML = '<div class="loading">Loading jobs...</div>';

    try {
      const response = await fetch(`/api/queues/${queueName}/jobs/${status}`);
      const jobs = await response.json();

      if (jobs.length === 0) {
        container.innerHTML = `<div class="loading">No ${status} jobs found.</div>`;
        return;
      }

      container.innerHTML = jobs.map((job) => this.createJobItem(job)).join("");
    } catch (error) {
      console.error("Error loading jobs:", error);
      container.innerHTML =
        '<div class="error-message">Failed to load jobs</div>';
    }
  }

  createJobItem(job) {
    const timestamp = job.timestamp
      ? new Date(job.timestamp).toLocaleString()
      : "N/A";
    const processedOn = job.processedOn
      ? new Date(job.processedOn).toLocaleString()
      : "N/A";
    const finishedOn = job.finishedOn
      ? new Date(job.finishedOn).toLocaleString()
      : "N/A";

    return `
            <div class="job-item">
                <div class="job-header">
                    <div class="job-id">Job ID: ${job.id}</div>
                    <div class="job-timestamp">Created: ${timestamp}</div>
                </div>
                ${
                  job.name
                    ? `<div><strong>Name:</strong> ${job.name}</div>`
                    : ""
                }
                ${
                  job.progress
                    ? `<div><strong>Progress:</strong> ${job.progress}%</div>`
                    : ""
                }
                ${
                  job.processedOn
                    ? `<div><strong>Processed:</strong> ${processedOn}</div>`
                    : ""
                }
                ${
                  job.finishedOn
                    ? `<div><strong>Finished:</strong> ${finishedOn}</div>`
                    : ""
                }
                ${
                  job.failedReason
                    ? `<div class="error-message"><strong>Failed:</strong> ${job.failedReason}</div>`
                    : ""
                }
                <div><strong>Data:</strong></div>
                <div class="job-data">${JSON.stringify(job.data, null, 2)}</div>
            </div>
        `;
  }

  initCharts() {
    try {
      // Initialize CPU chart
      const cpuCanvas = document.getElementById("cpu-chart");
      if (cpuCanvas) {
        this.cpuChart = cpuCanvas.getContext("2d");
        // Clear the canvas
        this.cpuChart.clearRect(0, 0, cpuCanvas.width, cpuCanvas.height);
        console.log("CPU chart initialized");
      } else {
        console.error("CPU chart canvas not found");
      }

      // Initialize Memory chart
      const memoryCanvas = document.getElementById("memory-chart");
      if (memoryCanvas) {
        this.memoryChart = memoryCanvas.getContext("2d");
        // Clear the canvas
        this.memoryChart.clearRect(
          0,
          0,
          memoryCanvas.width,
          memoryCanvas.height
        );
        console.log("Memory chart initialized");
      } else {
        console.error("Memory chart canvas not found");
      }
    } catch (error) {
      console.error("Error initializing charts:", error);
    }
  }

  updateRedisMetrics(metrics) {
    if (!metrics) {
      document.getElementById("redis-cpu").textContent = "N/A";
      document.getElementById("redis-memory").textContent = "N/A";
      document.getElementById("memory-total").textContent = "N/A";
      document.getElementById("redis-clients").textContent = "N/A";
      document.getElementById("redis-keys").textContent = "N/A";
      document.getElementById("keys-size").textContent = "N/A";
      return;
    }

    console.log("Updating Redis metrics:", metrics);

    // Update text values with safe parsing
    const cpuValue = parseFloat(metrics.cpu.current || 0);
    const memoryPercent = parseFloat(metrics.memory.usagePercent || 0);
    const maxMemory = parseInt(metrics.memory.max || 0);
    const connectedClients = parseInt(metrics.connectedClients || 0);
    const totalKeys = parseInt(metrics.totalKeys || 0);
    const keysSizeMB = parseInt(metrics.totalKeysSizeMB || 0);

    document.getElementById("redis-cpu").textContent = `${cpuValue.toFixed(
      2
    )}%`;
    document.getElementById(
      "redis-memory"
    ).textContent = `${memoryPercent.toFixed(1)}%`;

    // Calculate total memory in GB
    const totalMemoryGB =
      maxMemory > 0 ? (maxMemory / (1024 * 1024 * 1024)).toFixed(1) : "N/A";
    document.getElementById("memory-total").textContent =
      totalMemoryGB !== "N/A" ? `${totalMemoryGB} GB Total` : "N/A";

    document.getElementById("redis-clients").textContent = connectedClients;
    document.getElementById("redis-keys").textContent =
      totalKeys.toLocaleString();
    document.getElementById("keys-size").textContent = `${keysSizeMB} MB`;

    // Update charts with safe data
    this.updateChart(
      this.cpuChart,
      metrics.cpu.history || [0],
      "CPU Usage (%)",
      "#4299e1"
    );
    this.updateChart(
      this.memoryChart,
      metrics.memory.history || [0],
      "Memory Usage (%)",
      "#38a169"
    );
  }

  updateChart(ctx, data, label, color) {
    const canvas = ctx.canvas;
    const width = canvas.width;
    const height = canvas.height;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    this.drawLineChart(ctx, data, label, color);
  }

  drawLineChart(ctx, data, label, color) {
    const canvas = ctx.canvas;
    const width = canvas.width;
    const height = canvas.height;

    if (data.length < 2) return;

    // Set up chart styling
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.fillStyle = color + "20"; // Add transparency

    // Calculate points
    const maxValue = Math.max(...data, 1);
    const stepX = width / (data.length - 1);

    // Draw line
    ctx.beginPath();
    data.forEach((value, index) => {
      const x = index * stepX;
      const y = height - (value / maxValue) * height;

      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();

    // Fill area under curve
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fill();

    // Draw grid lines
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = (height / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  showError(message) {
    const grid = document.getElementById("queues-grid");
    grid.innerHTML = `<div class="error-message">${message}</div>`;
  }
}

// Initialize dashboard when page loads
document.addEventListener("DOMContentLoaded", () => {
  window.dashboard = new BullDashboard();
});
