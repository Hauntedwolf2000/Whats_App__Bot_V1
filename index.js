// index.js
// === Enhanced WhatsApp Support Bot (Corporate Standard with Stop/Restart Feature) ===

const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const moment = require("moment");
const express = require("express");

// Add these modifications to your existing index.js file

// At the top, after your imports, add:
const isDevelopment = process.env.NODE_ENV !== "production";

// Modify the Client initialization (around line 15):
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: ".wwebjs_auth",
  }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process", // This helps with memory issues
      "--disable-gpu",
    ],
    ...(process.env.NODE_ENV === "production" && {
      executablePath: "/usr/bin/google-chrome-stable",
    }),
  },
});

const app = express();
app.use(express.json());

// Add a health check endpoint (add this after your existing webhook endpoints):
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

// Add keep-alive functionality for free tier (add this after client.on('ready')):
if (process.env.NODE_ENV === "production") {
  const RENDER_URL =
    process.env.RENDER_EXTERNAL_URL ||
    `https://${process.env.RENDER_SERVICE_NAME}.onrender.com`;

  // Ping self every 14 minutes to prevent sleeping on free tier
  setInterval(() => {
    fetch(`${RENDER_URL}/health`)
      .then((res) => console.log(`Keep-alive ping successful: ${res.status}`))
      .catch((err) => console.log("Keep-alive ping failed:", err.message));
  }, 14 * 60 * 1000); // 14 minutes
}

// Add better error handling for production
if (process.env.NODE_ENV === "production") {
  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
  });

  process.on("uncaughtException", (error) => {
    console.error("Uncaught Exception:", error);
    // Don't exit in production, try to continue
  });
}

const SESSION_FILE = "ticket-counter.json";
const RESERVED_TICKETS_FILE = "reserved-tickets.json";
const IMAGE_PATH = "ulipsu-logo.png";
// ← Replace with your deployed Apps Script URL:
const GOOGLE_SHEETS_WEBHOOK =
  "https://script.google.com/macros/s/AKfycbwoo6wJ6ZFkxG3oaF4OqwdWSsC9Nv_3rpAcOVnGPH7X1Jeu3JkHKnpwxOz1MNMyzwZq/exec";

let sessions = {};
let ticketData = { lastTicket: 0 };
let reservedTickets = {}; // Track reserved but unused ticket IDs

// Load ticket data
if (fs.existsSync(SESSION_FILE)) {
  ticketData = JSON.parse(fs.readFileSync(SESSION_FILE));
}

// Load reserved tickets data
if (fs.existsSync(RESERVED_TICKETS_FILE)) {
  reservedTickets = JSON.parse(fs.readFileSync(RESERVED_TICKETS_FILE));
}

function generateTicketId(userId = null) {
  // If user has a reserved ticket, use it
  if (userId && reservedTickets[userId]) {
    const ticketId = reservedTickets[userId];
    delete reservedTickets[userId];
    saveReservedTickets();
    return ticketId;
  }

  // Generate new ticket ID
  ticketData.lastTicket++;
  fs.writeFileSync(SESSION_FILE, JSON.stringify(ticketData));

  const ticketId = `ULI${ticketData.lastTicket.toString().padStart(4, "0")}`;

  // Reserve this ticket for the user
  if (userId) {
    reservedTickets[userId] = ticketId;
    saveReservedTickets();
  }

  return ticketId;
}

function releaseReservedTicket(userId) {
  if (reservedTickets[userId]) {
    // Move the ticket ID back to available pool by decrementing counter
    const ticketId = reservedTickets[userId];
    const ticketNumber = parseInt(ticketId.replace("ULI", ""));

    // Only decrement if this was the last ticket issued
    if (ticketNumber === ticketData.lastTicket) {
      ticketData.lastTicket--;
      fs.writeFileSync(SESSION_FILE, JSON.stringify(ticketData));
    }

    delete reservedTickets[userId];
    saveReservedTickets();
    console.log(`Released reserved ticket ${ticketId} for user ${userId}`);
  }
}

function saveReservedTickets() {
  fs.writeFileSync(RESERVED_TICKETS_FILE, JSON.stringify(reservedTickets));
}

function isStopCommand(text) {
  const stopCommands = ["stop", "cancel", "quit", "exit", "abort", "end"];
  return stopCommands.includes(text.toLowerCase().trim());
}

function isRestartCommand(text) {
  const restartCommands = [
    "restart",
    "reset",
    "start over",
    "begin again",
    "new",
  ];
  return restartCommands.includes(text.toLowerCase().trim());
}

async function handleStopCommand(msg, user) {
  const session = sessions[user];

  await msg.reply(
    "🛑 Current process stopped.\n\n" +
      "What would you like to do?\n" +
      "1️⃣ Restart - Begin a new ticket\n" +
      "2️⃣ Exit - End conversation\n\n" +
      "Reply with '1' to restart or '2' to exit."
  );

  // Release reserved ticket if user stops
  if (session?.ticketId) {
    releaseReservedTicket(user);
  }

  sessions[user] = {
    stage: "awaitStopChoice",
    previousStage: session?.stage || "start",
    previousData: session?.details || {},
  };
}

async function handleRestartCommand(msg, user) {
  const session = sessions[user];

  // Release current reserved ticket
  if (session?.ticketId) {
    releaseReservedTicket(user);
  }

  // Start fresh
  resetSession(user);
  sessions[user].stage = "awaitSchoolCode";

  await msg.reply(
    "🔄 Process restarted!\n\n" +
      `🎫 Your New Ticket ID: ${sessions[user].ticketId}\n\n` +
      "Step 1 of 3: Please enter your School Code:\n\n" +
      "💡 You can type 'stop' anytime to cancel or 'restart' to begin again."
  );
}

async function checkExistingTickets(user) {
  try {
    const res = await fetch(
      `${GOOGLE_SHEETS_WEBHOOK}?action=checkTickets&user=${encodeURIComponent(
        user
      )}`,
      { method: "GET" }
    );
    const data = await res.json();
    return data.tickets || [];
  } catch (err) {
    console.error("Error fetching existing tickets:", err);
    return [];
  }
}

async function fetchTicketDetails(ticketId) {
  const url = `${GOOGLE_SHEETS_WEBHOOK}?action=getTicketDetails&ticketId=${encodeURIComponent(
    ticketId
  )}`;
  console.log("Fetching ticket details from:", url);
  try {
    const res = await fetch(url, { method: "GET" });
    const body = await res.json();
    console.log("Ticket details response:", body);
    return body.details || null;
  } catch (err) {
    console.error("Error fetching ticket details:", err);
    return null;
  }
}

function resetSession(user) {
  const ticketId = generateTicketId(user);
  sessions[user] = {
    stage: "start",
    ticketId: ticketId,
    status: "In Progress",
    details: {
      schoolCode: "",
      studentId: "",
      issueDescription: "",
      screenshotUrl: "",
      userComments: "",
    },
  };
}

async function logToGoogleSheet(session, user) {
  const payload = {
    action: "create",
    ticketId: session.ticketId,
    raisedBy: user,
    reportingDate: moment().format("D/M/YYYY, HH:mm:ss"),
    schoolCode: session.details.schoolCode,
    studentPin: session.details.studentId,
    issueDescription: session.details.issueDescription,
    screenshotUrl: session.details.screenshotUrl,
    status: session.status,
  };
  try {
    const res = await fetch(GOOGLE_SHEETS_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (err) {
    console.error("Error logging ticket:", err);
    return false;
  }
}

async function updateTicketStatus(ticketId, status, resolution = "") {
  const payload = {
    action: "updateStatus",
    ticketId,
    status,
    closureDate:
      status === "Closed" ? moment().format("D/M/YYYY, HH:mm:ss") : "",
    resolution,
  };
  try {
    const res = await fetch(GOOGLE_SHEETS_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (err) {
    console.error("Error updating status:", err);
    return false;
  }
}

async function addUserComment(ticketId, comment, timestamp) {
  const payload = {
    action: "addReopenReason",
    ticketId,
    reopenReason: comment,
    reopenDate: timestamp,
  };
  try {
    const res = await fetch(GOOGLE_SHEETS_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (err) {
    console.error("Error adding user comment:", err);
    return false;
  }
}

async function addSupportResolution(ticketId, resolution) {
  const payload = {
    action: "addSupportResolution",
    ticketId,
    resolution,
  };
  try {
    const res = await fetch(GOOGLE_SHEETS_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (err) {
    console.error("Error adding support resolution:", err);
    return false;
  }
}

// Enhanced webhook handler for ticket resolution
app.post("/webhook/ticket-resolved", async (req, res) => {
  const { ticketId, userPhone, resolution } = req.body;
  try {
    const d = await fetchTicketDetails(ticketId);
    let detailsText = "";
    if (d) {
      detailsText =
        `Ticket ID: ${ticketId}\n` +
        `School Name: ${d.schoolName || "N/A"}\n` +
        `School Code: ${d.schoolCode}\n` +
        `Student PIN: ${d.studentPin}\n` +
        `Issue: ${d.issueDescription}\n`;
    }

    const message =
      `Dear User,\n\n` +
      `Your ticket has been marked as resolved by the support team. Below are the details of your ticket:\n\n` +
      detailsText +
      `Resolution message from support:\n${resolution}\n\n` +
      `Please reply with *1* if your issue is resolved or *2* to Reopen for further support.`;

    await client.sendMessage(userPhone, message);
    sessions[userPhone] = {
      stage: "awaitNumericConfirmation",
      ticketId,
      resolution,
      supportResolution: resolution,
    };
    res.json({ success: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: err.message });
  }
});

// New webhook for support team to add resolution comments
app.post("/webhook/support-resolution", async (req, res) => {
  const { ticketId, resolution } = req.body;
  try {
    const success = await addSupportResolution(ticketId, resolution);
    if (success) {
      res.json({
        success: true,
        message: "Support resolution added successfully",
      });
    } else {
      res.status(500).json({ error: "Failed to add support resolution" });
    }
  } catch (err) {
    console.error("Support resolution webhook error:", err);
    res.status(500).json({ error: err.message });
  }
});

client.on("qr", (qr) => qrcode.generate(qr, { small: true }));
client.on("ready", () => {
  console.log("Enhanced WhatsApp support bot is ready.");
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
});

client.on("message", async (msg) => {
  const user = msg.from;
  const text = msg.body.trim().toLowerCase();

  // Handle stop/restart commands at any stage (except initial greeting)
  if (sessions[user] && sessions[user].stage !== "start") {
    if (isStopCommand(text)) {
      await handleStopCommand(msg, user);
      return;
    }
    if (isRestartCommand(text)) {
      await handleRestartCommand(msg, user);
      return;
    }
  }

  // Handle stop choice after user typed 'stop'
  if (sessions[user]?.stage === "awaitStopChoice") {
    if (text === "1") {
      await handleRestartCommand(msg, user);
      return;
    } else if (text === "2") {
      await msg.reply(
        "👋 Thank you for using Ulipsu Support!\n\n" +
          "You can start again anytime by typing 'Hi'.\n" +
          "📞 For urgent assistance: +91 88848 19888"
      );
      delete sessions[user];
      return;
    } else {
      await msg.reply(
        "❌ Invalid choice. Please reply:\n" +
          "1️⃣ Restart - Begin a new ticket\n" +
          "2️⃣ Exit - End conversation"
      );
      return;
    }
  }

  // Enhanced numeric confirmation after resolution
  if (sessions[user]?.stage === "awaitNumericConfirmation") {
    if (text === "1") {
      await updateTicketStatus(
        sessions[user].ticketId,
        "Closed",
        sessions[user].supportResolution
      );
      await msg.reply(
        "Thank you for confirming. Your ticket has been closed successfully."
      );
      delete sessions[user];
    } else if (text === "2") {
      await updateTicketStatus(sessions[user].ticketId, "Reopened");
      await msg.reply(
        "Your ticket has been reopened. Please describe the specific issue or concern that remains unresolved:\n\n" +
          "💡 You can type 'stop' to cancel or 'restart' for a new ticket."
      );
      sessions[user].stage = "awaitReopenReason";
    } else {
      await msg.reply(
        "Invalid input. Please reply:\n*1* - Issue is resolved (close ticket)\n*2* - Issue not resolved (reopen ticket)"
      );
    }
    return;
  }

  // Enhanced reopen reason handling
  if (sessions[user]?.stage === "awaitReopenReason") {
    const reason = msg.body.trim();
    const timestamp = moment().format("D/M/YYYY, HH:mm:ss");

    await addUserComment(sessions[user].ticketId, reason, timestamp);
    await msg.reply(
      "Your concern has been recorded and the ticket has been reopened. Our support team will review your feedback and get back to you shortly.\n\n" +
        "For urgent assistance, please call +91 88848 19888."
    );
    delete sessions[user];
    return;
  }

  // Avoid group, broadcast, or status messages
  if (
    msg.from.includes("@g.us") ||
    msg.from === "status@broadcast" ||
    msg.isStatus
  ) {
    return;
  }

  // Initial greeting / enhanced menu
  if (!sessions[user]) {
    if (["hi", "hello", "hey"].includes(text)) {
      const existing = await checkExistingTickets(user);
      const open = existing.filter((t) =>
        ["Open", "In Progress", "Reopened"].includes(t.status)
      );

      if (open.length > 0) {
        const list = open
          .map(
            (t, i) => `${i + 1}) Ticket ID: ${t.ticketId} – Status: ${t.status}`
          )
          .join("\n");

        await msg.reply(
          `🎯 Welcome to Ulipsu Support!\n\n` +
            `You have ${open.length} active ticket(s):\n${list}\n\n` +
            `Please choose an option:\n` +
            `1️⃣ Open a new ticket\n` +
            `2️⃣ Close an existing ticket\n` +
            `3️⃣ View status of existing tickets\n\n` +
            `📞 For urgent help: +91 88848 19888`
        );
        sessions[user] = {
          stage: "existingTicketChoice",
          existingTickets: open,
        };
      } else {
        const media = MessageMedia.fromFilePath(IMAGE_PATH);
        await client.sendMessage(user, media, {
          caption:
            "🎯 Welcome to Ulipsu Support!\n\nWould you like to open a new support ticket?\n\nReply 'Yes' to proceed or 'No' to cancel.",
        });
        sessions[user] = { stage: "confirmStart" };
      }
    } else {
      await msg.reply(
        "👋 Hello! Please type 'Hi' or 'Hello' to start using Ulipsu Support.\n\n📞 For urgent assistance: +91 88848 19888"
      );
    }
    return;
  }

  const session = sessions[user];

  // Enhanced menu for existing tickets
  if (session.stage === "existingTicketChoice") {
    if (text === "1") {
      resetSession(user);
      sessions[user].stage = "awaitSchoolCode";
      await msg.reply(
        `🎫 New Ticket Created: ${sessions[user].ticketId}\n\n` +
          `Step 1 of 3: Please enter your School Code:\n\n` +
          `💡 You can type 'stop' anytime to cancel or 'restart' to begin again.`
      );
      return;
    }
    if (text === "2") {
      const list = session.existingTickets
        .map(
          (t, i) => `${i + 1}) Ticket ID: ${t.ticketId} – Status: ${t.status}`
        )
        .join("\n");
      sessions[user].stage = "awaitCloseSelection";
      await msg.reply(
        `🔒 Select the ticket number you want to close:\n\n${list}\n\n` +
          `Please reply with the number (1, 2, 3, etc.)\n\n` +
          `💡 Type 'stop' to cancel this action.`
      );
      return;
    }
    if (text === "3") {
      let reply = "📊 Support Ticket Status:\n\n";
      session.existingTickets.forEach((t, idx) => {
        reply +=
          `${idx + 1}. Ticket ID: ${t.ticketId}\n` +
          `   Status: ${t.status}\n` +
          `   Created: ${t.reportingDate}\n\n`;
      });
      reply += "📞 For urgent assistance: +91 88848 19888";
      await msg.reply(reply);
      delete sessions[user];
      return;
    }
    await msg.reply("❌ Invalid choice. Please reply with '1', '2', or '3'.");
    return;
  }

  // Enhanced close-ticket selection
  if (session.stage === "awaitCloseSelection") {
    const idx = parseInt(text, 10) - 1;
    const ticket = session.existingTickets[idx];
    if (!ticket) {
      await msg.reply(
        "❌ Invalid number. Please select a valid ticket number from the list above."
      );
      return;
    }
    await updateTicketStatus(
      ticket.ticketId,
      "Closed",
      "Closed by user via WhatsApp"
    );
    await msg.reply(
      `✅ Ticket ${ticket.ticketId} has been closed successfully.\n\n` +
        `Thank you for using Ulipsu Support!\n📞 For urgent help: +91 88848 19888`
    );
    delete sessions[user];
    return;
  }

  // Enhanced confirmation to open new ticket
  if (session.stage === "confirmStart") {
    if (["yes", "y", "ok", "sure", "proceed"].includes(text)) {
      resetSession(user);
      sessions[user].stage = "awaitSchoolCode";
      await msg.reply(
        `🎫 Your Ticket ID: ${sessions[user].ticketId}\n\n` +
          `Step 1 of 3: Please enter your School Code:\n\n` +
          `💡 You can type 'stop' anytime to cancel or 'restart' to begin again.`
      );
    } else if (["no", "n", "cancel", "stop"].includes(text)) {
      delete sessions[user];
      await msg.reply(
        "👍 No problem! You can start again anytime by typing 'Hi'.\n\n📞 For urgent assistance: +91 88848 19888"
      );
    } else {
      await msg.reply(
        "Please reply 'Yes' to proceed with creating a ticket or 'No' to cancel."
      );
    }
    return;
  }

  // Enhanced new ticket flow: School Code
  if (session.stage === "awaitSchoolCode") {
    const schoolCode = msg.body.trim().toUpperCase();
    if (!schoolCode) {
      await msg.reply(
        "⚠️ School Code cannot be empty. Please enter a valid School Code:\n\n" +
          "💡 Type 'stop' to cancel or 'restart' to begin again."
      );
      return;
    }
    session.details.schoolCode = schoolCode;
    sessions[user].stage = "awaitStudentPin";
    await msg.reply(
      `Step 2 of 3: Please enter Student PIN(s):\n\n` +
        `💡 Type 'stop' to cancel or 'restart' to begin again.`
    );
    return;
  }

  // Enhanced Student PIN
  if (session.stage === "awaitStudentPin") {
    const studentPin = msg.body.trim();
    if (!studentPin) {
      await msg.reply(
        "⚠️ Student PIN cannot be empty. Please enter a valid Student PIN:\n\n" +
          "💡 Type 'stop' to cancel or 'restart' to begin again."
      );
      return;
    }
    session.details.studentId = studentPin;
    sessions[user].stage = "awaitDetailsAndMedia";
    await msg.reply(
      "Step 3 of 3: Please provide:\n\n" +
        "📝 Detailed description of the issue\n" +
        "📷 Screenshot or video (optional but recommended)\n\n" +
        "You can either share the image/video with the description in the caption, or send the media first and follow up with the description separately—whichever is easier for you.\n\n" +
        "💡 Type 'stop' to cancel or 'restart' to begin again."
    );
    return;
  }

  // Enhanced details & media handling
  if (session.stage === "awaitDetailsAndMedia") {
    let issueDescription = session.details.issueDescription || "";

    // Handle text description
    if (msg.body && msg.body.trim()) {
      if (issueDescription) {
        issueDescription += "\n" + msg.body.trim();
      } else {
        issueDescription = msg.body.trim();
      }
      session.details.issueDescription = issueDescription;
    }

    // Handle media
    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        session.details.screenshotUrl = `data:${media.mimetype};base64,${media.data}`;
        await msg.reply("📷 Media received successfully!");
      } catch (err) {
        console.error("Error downloading media:", err);
        await msg.reply(
          "⚠️ Error processing media. Continuing with text description only."
        );
      }
    }

    // Check if we have sufficient information
    if (
      !session.details.issueDescription ||
      session.details.issueDescription.trim().length < 10
    ) {
      await msg.reply(
        "⚠️ Please provide a more detailed description of the issue (minimum 10 characters). " +
          "This helps our support team understand and resolve your problem faster.\n\n" +
          "💡 Type 'stop' to cancel or 'restart' to begin again."
      );
      return;
    }

    // Log ticket to Google Sheets
    const success = await logToGoogleSheet(session, user);

    if (success) {
      // Remove ticket from reserved pool since it's now successfully created
      delete reservedTickets[user];
      saveReservedTickets();

      const summary =
        `✅ Ticket ${session.ticketId} created successfully!\n\n` +
        `📋 Summary:\n` +
        `🏫 School Code: ${session.details.schoolCode}\n` +
        `👤 Student PIN: ${session.details.studentId}\n` +
        `📝 Issue: ${session.details.issueDescription.substring(0, 100)}${
          session.details.issueDescription.length > 100 ? "..." : ""
        }\n` +
        `📷 Media: ${
          session.details.screenshotUrl ? "Attached" : "Not provided"
        }\n\n` +
        `🔄 Our support team will review your request and update you shortly.\n` +
        `For urgent assistance please write us at: support@ulipsu.com`;

      await msg.reply(summary);
    } else {
      await msg.reply(
        `❌ Failed to create ticket. Please try again later or contact support directly at +91 88848 19888.\n\n` +
          `Your ticket details have been saved locally: ${session.ticketId}`
      );
    }
    delete sessions[user];
    return;
  }
});

// Enhanced error handling
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("Shutting down WhatsApp bot...");
  client.destroy();
  process.exit(0);
});

client.initialize();
