// @ts-nocheck
/**
 * Claw-Eval Mock Service Tools — OpenClaw Plugin
 *
 * Wraps every Claw-Eval mock service HTTP endpoint as a first-class OpenClaw
 * tool via api.registerTool(). OpenClaw's agent can then call these tools
 * directly instead of issuing raw HTTP requests, while the mock services
 * continue to run as separate FastAPI processes (audit logs untouched).
 *
 * Service base URLs are resolved from environment variables:
 *   CLAW_EVAL_GMAIL_URL       (default: http://localhost:9100)
 *   CLAW_EVAL_CALENDAR_URL    (default: http://localhost:9101)
 *   CLAW_EVAL_TODO_URL        (default: http://localhost:9102)
 *   CLAW_EVAL_CONTACTS_URL    (default: http://localhost:9103)
 *   CLAW_EVAL_FINANCE_URL     (default: http://localhost:9104)
 *   CLAW_EVAL_NOTES_URL       (default: http://localhost:9105)
 *   CLAW_EVAL_KB_URL          (default: http://localhost:9106)
 *   CLAW_EVAL_HELPDESK_URL    (default: http://localhost:9107)
 *   CLAW_EVAL_INVENTORY_URL   (default: http://localhost:9108)
 *   CLAW_EVAL_RSS_URL         (default: http://localhost:9109)
 *   CLAW_EVAL_CRM_URL         (default: http://localhost:9110)
 *   CLAW_EVAL_CONFIG_URL      (default: http://localhost:9111)
 *   CLAW_EVAL_SCHEDULER_URL   (default: http://localhost:9112)
 *   CLAW_EVAL_WEB_URL         (default: http://localhost:9113)
 *   CLAW_EVAL_WEB_REAL_URL    (default: http://localhost:9114)
 *   CLAW_EVAL_WEB_INJ_URL     (default: http://localhost:9115)
 *   CLAW_EVAL_OCR_URL         (default: http://localhost:9116)
 *   CLAW_EVAL_CAPTION_URL     (default: http://localhost:9118)
 *   CLAW_EVAL_DOCUMENTS_URL   (default: http://localhost:9119)
 */

// ── Service URL helpers ────────────────────────────────────────────────────

const SVC = {
  gmail:     process.env.CLAW_EVAL_GMAIL_URL     || "http://localhost:9100",
  calendar:  process.env.CLAW_EVAL_CALENDAR_URL  || "http://localhost:9101",
  todo:      process.env.CLAW_EVAL_TODO_URL      || "http://localhost:9102",
  contacts:  process.env.CLAW_EVAL_CONTACTS_URL  || "http://localhost:9103",
  finance:   process.env.CLAW_EVAL_FINANCE_URL   || "http://localhost:9104",
  notes:     process.env.CLAW_EVAL_NOTES_URL     || "http://localhost:9105",
  kb:        process.env.CLAW_EVAL_KB_URL        || "http://localhost:9106",
  helpdesk:  process.env.CLAW_EVAL_HELPDESK_URL  || "http://localhost:9107",
  inventory: process.env.CLAW_EVAL_INVENTORY_URL || "http://localhost:9108",
  rss:       process.env.CLAW_EVAL_RSS_URL       || "http://localhost:9109",
  crm:       process.env.CLAW_EVAL_CRM_URL       || "http://localhost:9110",
  config:    process.env.CLAW_EVAL_CONFIG_URL    || "http://localhost:9111",
  scheduler: process.env.CLAW_EVAL_SCHEDULER_URL || "http://localhost:9112",
  web:       process.env.CLAW_EVAL_WEB_URL       || "http://localhost:9113",
  webReal:   process.env.CLAW_EVAL_WEB_REAL_URL  || "http://localhost:9114",
  webInj:    process.env.CLAW_EVAL_WEB_INJ_URL   || "http://localhost:9115",
  ocr:       process.env.CLAW_EVAL_OCR_URL       || "http://localhost:9116",
  caption:   process.env.CLAW_EVAL_CAPTION_URL   || "http://localhost:9118",
  documents: process.env.CLAW_EVAL_DOCUMENTS_URL || "http://localhost:9119",
};

/**
 * POST JSON to a mock service endpoint and return parsed response body.
 * @param {string} url  Full URL to POST to.
 * @param {object} body Request payload (will be JSON-serialised).
 * @returns {Promise<object>}
 */
async function svcPost(url, body = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    data = { error: `HTTP ${res.status}`, detail: data };
  }
  return data;
}

/**
 * Wrap a service call result as an OpenClaw tool execute return value.
 * @param {object} data
 * @returns {{ content: Array, details: object }}
 */
function toolResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    details: { response: data },
  };
}

// ── Tool definitions ───────────────────────────────────────────────────────

/**
 * @typedef {{ label: string, name: string, description: string, parameters: object, execute: Function }} ToolDef
 */

/** @returns {ToolDef[]} */
function buildToolDefs() {
  return [

    // ── Gmail ────────────────────────────────────────────────────────────
    {
      label: "Gmail: List Messages",
      name: "gmail_list_messages",
      description: "List emails from the inbox filtered by recency. Returns message_id, from, subject, date, is_read, labels.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          days_back:   { type: "integer", description: "How many days back to search (default 7)." },
          max_results: { type: "integer", description: "Max number of messages to return (default 20)." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.gmail}/gmail/messages`, args)),
    },
    {
      label: "Gmail: Get Message",
      name: "gmail_get_message",
      description: "Retrieve a single email by its message_id, including full body.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["message_id"],
        properties: {
          message_id: { type: "string", description: "The message_id from gmail_list_messages." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.gmail}/gmail/messages/get`, args)),
    },
    {
      label: "Gmail: Send Message",
      name: "gmail_send_message",
      description: "Send an email immediately. Use only when the task explicitly requires sending.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["to", "subject", "body"],
        properties: {
          to:      { type: "string", description: "Recipient email address." },
          subject: { type: "string", description: "Email subject line." },
          body:    { type: "string", description: "Email body text." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.gmail}/gmail/send`, args)),
    },
    {
      label: "Gmail: Save Draft",
      name: "gmail_save_draft",
      description: "Save an email as a draft without sending. Prefer this for drafting tasks.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["to", "subject", "body"],
        properties: {
          to:                  { type: "string", description: "Recipient email address." },
          subject:             { type: "string", description: "Email subject line." },
          body:                { type: "string", description: "Email body text." },
          reply_to_message_id: { type: "string", description: "Optional message_id this draft replies to." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.gmail}/gmail/drafts/save`, args)),
    },

    // ── Calendar ─────────────────────────────────────────────────────────
    {
      label: "Calendar: List Events",
      name: "calendar_list_events",
      description: "List calendar events for a given date range.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["date"],
        properties: {
          date: { type: "string", description: "Start date in YYYY-MM-DD format." },
          days: { type: "integer", description: "Number of days to cover (default 1)." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.calendar}/calendar/events`, args)),
    },
    {
      label: "Calendar: Get Event",
      name: "calendar_get_event",
      description: "Retrieve a single calendar event by event_id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["event_id"],
        properties: {
          event_id: { type: "string", description: "The event_id from calendar_list_events." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.calendar}/calendar/events/get`, args)),
    },
    {
      label: "Calendar: Create Event",
      name: "calendar_create_event",
      description: "Create a new calendar event.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "start_time", "end_time"],
        properties: {
          title:      { type: "string", description: "Event title." },
          start_time: { type: "string", description: "Start time in ISO 8601 format (e.g. 2026-04-28T09:00:00Z)." },
          end_time:   { type: "string", description: "End time in ISO 8601 format." },
          attendees:  { type: "array", items: { type: "string" }, description: "List of attendee email addresses." },
          location:   { type: "string", description: "Event location." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.calendar}/calendar/events/create`, args)),
    },
    {
      label: "Calendar: Get User Events",
      name: "calendar_get_user_events",
      description: "Get all calendar events for a specific user on a given date.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["user", "date"],
        properties: {
          user: { type: "string", description: "User email or name to look up." },
          date: { type: "string", description: "Date in YYYY-MM-DD format." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.calendar}/calendar/user_events`, args)),
    },
    {
      label: "Calendar: Delete Event",
      name: "calendar_delete_event",
      description: "Delete a calendar event by event_id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["event_id"],
        properties: {
          event_id: { type: "string", description: "The event_id to delete." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.calendar}/calendar/events/delete`, args)),
    },

    // ── Todo ─────────────────────────────────────────────────────────────
    {
      label: "Todo: List Tasks",
      name: "todo_list_tasks",
      description: "List todo tasks optionally filtered by status.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", description: "Filter by status: all | open | in_progress | done (default: all)." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.todo}/todo/tasks`, args)),
    },
    {
      label: "Todo: Create Task",
      name: "todo_create_task",
      description: "Create a new todo task.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title:       { type: "string", description: "Task title." },
          description: { type: "string", description: "Task description." },
          priority:    { type: "string", description: "Priority: low | medium | high (default: medium)." },
          due_date:    { type: "string", description: "Due date in YYYY-MM-DD format." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.todo}/todo/tasks/create`, args)),
    },
    {
      label: "Todo: Update Task",
      name: "todo_update_task",
      description: "Update an existing todo task's fields.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["task_id"],
        properties: {
          task_id:  { type: "string", description: "ID of the task to update." },
          title:    { type: "string", description: "New title." },
          priority: { type: "string", description: "New priority: low | medium | high." },
          status:   { type: "string", description: "New status: open | in_progress | done." },
          tags:     { type: "array", items: { type: "string" }, description: "New tag list." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.todo}/todo/tasks/update`, args)),
    },
    {
      label: "Todo: Delete Task",
      name: "todo_delete_task",
      description: "Delete a todo task by task_id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["task_id"],
        properties: {
          task_id: { type: "string", description: "ID of the task to delete." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.todo}/todo/tasks/delete`, args)),
    },

    // ── Contacts ─────────────────────────────────────────────────────────
    {
      label: "Contacts: Search",
      name: "contacts_search",
      description: "Search for contacts by name, email, or keyword. Optionally filter by department.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query:      { type: "string", description: "Search query string." },
          department: { type: "string", description: "Optional department filter." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.contacts}/contacts/search`, args)),
    },
    {
      label: "Contacts: Get Contact",
      name: "contacts_get",
      description: "Get full details of a contact by contact_id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["contact_id"],
        properties: {
          contact_id: { type: "string", description: "Contact ID from contacts_search." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.contacts}/contacts/get`, args)),
    },
    {
      label: "Contacts: Send Message",
      name: "contacts_send_message",
      description: "Send a message to a contact.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["contact_id", "message"],
        properties: {
          contact_id: { type: "string", description: "Recipient contact ID." },
          message:    { type: "string", description: "Message text to send." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.contacts}/contacts/send_message`, args)),
    },

    // ── Finance ───────────────────────────────────────────────────────────
    {
      label: "Finance: List Transactions",
      name: "finance_list_transactions",
      description: "List financial transactions, optionally filtered by date range.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          start_date: { type: "string", description: "Start date filter (YYYY-MM-DD)." },
          end_date:   { type: "string", description: "End date filter (YYYY-MM-DD)." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.finance}/finance/transactions`, args)),
    },
    {
      label: "Finance: Get Transaction",
      name: "finance_get_transaction",
      description: "Get details of a single transaction by transaction_id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["transaction_id"],
        properties: {
          transaction_id: { type: "string", description: "Transaction ID." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.finance}/finance/transactions/get`, args)),
    },
    {
      label: "Finance: Submit Expense Report",
      name: "finance_submit_report",
      description: "Submit an expense report grouping a list of transactions.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "transactions", "total_amount"],
        properties: {
          title:        { type: "string", description: "Report title." },
          transactions: { type: "array", items: { type: "string" }, description: "List of transaction IDs to include." },
          total_amount: { type: "number", description: "Total amount of the report." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.finance}/finance/report/submit`, args)),
    },

    // ── Notes ─────────────────────────────────────────────────────────────
    {
      label: "Notes: List Notes",
      name: "notes_list",
      description: "List recent notes.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          max_results: { type: "integer", description: "Max notes to return (default 10)." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.notes}/notes/list`, args)),
    },
    {
      label: "Notes: Get Note",
      name: "notes_get",
      description: "Get the full content of a note by note_id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["note_id"],
        properties: {
          note_id: { type: "string", description: "Note ID from notes_list." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.notes}/notes/get`, args)),
    },
    {
      label: "Notes: Share Note",
      name: "notes_share",
      description: "Share a note with a list of recipients.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["note_id", "recipients"],
        properties: {
          note_id:    { type: "string", description: "Note ID to share." },
          recipients: { type: "array", items: { type: "string" }, description: "List of recipient emails or names." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.notes}/notes/share`, args)),
    },

    // ── Knowledge Base ────────────────────────────────────────────────────
    {
      label: "KB: Search Articles",
      name: "kb_search",
      description: "Search the knowledge base for articles by keyword, optionally filtered by category.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query:       { type: "string", description: "Search query." },
          category:    { type: "string", description: "Optional category filter." },
          max_results: { type: "integer", description: "Max results (default 5)." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.kb}/kb/search`, args)),
    },
    {
      label: "KB: Get Article",
      name: "kb_get_article",
      description: "Get the full content of a knowledge base article by article_id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["article_id"],
        properties: {
          article_id: { type: "string", description: "Article ID from kb_search." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.kb}/kb/articles/get`, args)),
    },
    {
      label: "KB: Update Article",
      name: "kb_update_article",
      description: "Update the content of a knowledge base article.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["article_id", "content"],
        properties: {
          article_id: { type: "string", description: "Article ID to update." },
          content:    { type: "string", description: "New article content." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.kb}/kb/articles/update`, args)),
    },

    // ── Helpdesk ──────────────────────────────────────────────────────────
    {
      label: "Helpdesk: List Tickets",
      name: "helpdesk_list_tickets",
      description: "List support tickets filtered by status.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", description: "Filter by status: open | in_progress | closed (default: open)." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.helpdesk}/helpdesk/tickets`, args)),
    },
    {
      label: "Helpdesk: Get Ticket",
      name: "helpdesk_get_ticket",
      description: "Get full details of a support ticket by ticket_id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["ticket_id"],
        properties: {
          ticket_id: { type: "string", description: "Ticket ID from helpdesk_list_tickets." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.helpdesk}/helpdesk/tickets/get`, args)),
    },
    {
      label: "Helpdesk: Update Ticket",
      name: "helpdesk_update_ticket",
      description: "Update priority, tags, or category of a support ticket.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["ticket_id"],
        properties: {
          ticket_id: { type: "string", description: "Ticket ID to update." },
          priority:  { type: "string", description: "New priority: low | medium | high | urgent." },
          tags:      { type: "array", items: { type: "string" }, description: "New tag list." },
          category:  { type: "string", description: "New category string." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.helpdesk}/helpdesk/tickets/update`, args)),
    },
    {
      label: "Helpdesk: Close Ticket",
      name: "helpdesk_close_ticket",
      description: "Close a support ticket with a resolution note.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["ticket_id", "resolution"],
        properties: {
          ticket_id:  { type: "string", description: "Ticket ID to close." },
          resolution: { type: "string", description: "Resolution description." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.helpdesk}/helpdesk/tickets/close`, args)),
    },

    // ── Inventory ─────────────────────────────────────────────────────────
    {
      label: "Inventory: List Products",
      name: "inventory_list_products",
      description: "List inventory products, optionally filtered by category.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: { type: "string", description: "Optional product category filter." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.inventory}/inventory/products`, args)),
    },
    {
      label: "Inventory: List Items",
      name: "inventory_list_items",
      description: "Alias of inventory_list_products for upstream claw-eval task compatibility.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: { type: "string", description: "Optional product category filter." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.inventory}/inventory/products`, args)),
    },
    {
      label: "Inventory: Get Product",
      name: "inventory_get_product",
      description: "Get details of a specific inventory product by product_id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["product_id"],
        properties: {
          product_id: { type: "string", description: "Product ID from inventory_list_products." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.inventory}/inventory/products/get`, args)),
    },
    {
      label: "Inventory: Get Item",
      name: "inventory_get_item",
      description: "Alias of inventory_get_product for upstream claw-eval task compatibility.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["product_id"],
        properties: {
          product_id: { type: "string", description: "Product ID from inventory_list_items." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.inventory}/inventory/products/get`, args)),
    },
    {
      label: "Inventory: Create Order",
      name: "inventory_create_order",
      description: "Place a restock order for a product.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["product_id", "quantity"],
        properties: {
          product_id: { type: "string", description: "Product ID to restock." },
          quantity:   { type: "integer", description: "Number of units to order." },
          supplier:   { type: "string", description: "Optional supplier name." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.inventory}/inventory/orders/create`, args)),
    },

    // ── RSS ───────────────────────────────────────────────────────────────
    {
      label: "RSS: List Feeds",
      name: "rss_list_feeds",
      description: "List available RSS feed sources, optionally filtered by category.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: { type: "string", description: "Optional category filter." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.rss}/rss/feeds`, args)),
    },
    {
      label: "RSS: List Articles",
      name: "rss_list_articles",
      description: "List recent articles from RSS feeds, optionally filtered by source or category.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          source:      { type: "string", description: "Filter by feed source name." },
          category:    { type: "string", description: "Filter by category." },
          max_results: { type: "integer", description: "Max articles to return (default 20)." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.rss}/rss/articles`, args)),
    },
    {
      label: "RSS: Get Article",
      name: "rss_get_article",
      description: "Get the full content of an RSS article by article_id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["article_id"],
        properties: {
          article_id: { type: "string", description: "Article ID from rss_list_articles." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.rss}/rss/articles/get`, args)),
    },
    {
      label: "RSS: Publish Newsletter",
      name: "rss_publish",
      description: "Publish a newsletter or digest article to recipients.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "content"],
        properties: {
          title:      { type: "string", description: "Newsletter title." },
          content:    { type: "string", description: "Newsletter body content." },
          recipients: { type: "array", items: { type: "string" }, description: "List of recipient emails." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.rss}/rss/publish`, args)),
    },

    // ── CRM ───────────────────────────────────────────────────────────────
    {
      label: "CRM: List Customers",
      name: "crm_list_customers",
      description: "List CRM customers, optionally filtered by status, tier, or industry.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          status:   { type: "string", description: "Filter by customer status." },
          tier:     { type: "string", description: "Filter by tier (e.g. gold, silver)." },
          industry: { type: "string", description: "Filter by industry." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.crm}/crm/customers`, args)),
    },
    {
      label: "CRM: Get Customer",
      name: "crm_get_customer",
      description: "Get full details of a CRM customer record by customer_id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["customer_id"],
        properties: {
          customer_id: { type: "string", description: "Customer ID from crm_list_customers." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.crm}/crm/customers/get`, args)),
    },
    {
      label: "CRM: Export Report",
      name: "crm_export_report",
      description: "Export a CRM summary report for a list of customers.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["title", "customer_ids", "summary"],
        properties: {
          title:        { type: "string", description: "Report title." },
          customer_ids: { type: "array", items: { type: "string" }, description: "Customer IDs to include." },
          summary:      { type: "string", description: "Report summary text." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.crm}/crm/export`, args)),
    },

    // ── Scheduler ─────────────────────────────────────────────────────────
    {
      label: "Scheduler: List Jobs",
      name: "scheduler_list_jobs",
      description: "List scheduled jobs, optionally filtered by status, enabled state, or tag.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          status:  { type: "string", description: "Filter by job status." },
          enabled: { type: "boolean", description: "Filter by enabled/disabled state." },
          tag:     { type: "string", description: "Filter by job tag." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.scheduler}/scheduler/jobs`, args)),
    },
    {
      label: "Scheduler: Get Job",
      name: "scheduler_get_job",
      description: "Get details of a specific scheduled job by job_id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["job_id"],
        properties: {
          job_id: { type: "string", description: "Job ID from scheduler_list_jobs." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.scheduler}/scheduler/jobs/get`, args)),
    },
    {
      label: "Scheduler: Create Job",
      name: "scheduler_create_job",
      description: "Create a new scheduled job with a cron expression.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["name", "cron_expression", "action"],
        properties: {
          name:            { type: "string", description: "Job name." },
          cron_expression: { type: "string", description: "Cron schedule expression (e.g. '0 9 * * 1')." },
          action:          { type: "string", description: "Action to execute (description or command)." },
          enabled:         { type: "boolean", description: "Whether the job is enabled (default true)." },
          tags:            { type: "array", items: { type: "string" }, description: "Optional tags for the job." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.scheduler}/scheduler/jobs/create`, args)),
    },
    {
      label: "Scheduler: Update Job",
      name: "scheduler_update_job",
      description: "Update an existing scheduled job.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["job_id"],
        properties: {
          job_id:          { type: "string", description: "Job ID to update." },
          enabled:         { type: "boolean", description: "New enabled state." },
          cron_expression: { type: "string", description: "New cron expression." },
          name:            { type: "string", description: "New job name." },
          action:          { type: "string", description: "New action." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.scheduler}/scheduler/jobs/update`, args)),
    },
    {
      label: "Scheduler: Delete Job",
      name: "scheduler_delete_job",
      description: "Delete a scheduled job by job_id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["job_id"],
        properties: {
          job_id: { type: "string", description: "Job ID to delete." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.scheduler}/scheduler/jobs/delete`, args)),
    },
    {
      label: "Scheduler: Get Job History",
      name: "scheduler_get_job_history",
      description: "Get execution history for a scheduled job.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["job_id"],
        properties: {
          job_id: { type: "string", description: "Job ID to get history for." },
          limit:  { type: "integer", description: "Max history entries to return (default 10)." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.scheduler}/scheduler/jobs/history`, args)),
    },

    // ── Config / Integration ────────────────────────────────────────────
    {
      label: "Config: List Integrations",
      name: "config_list_integrations",
      description: "List integrations and status metadata.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", description: "Optional status filter." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.config}/config/integrations`, args)),
    },
    {
      label: "Config: Get Integration",
      name: "config_get_integration",
      description: "Get full integration details by integration_id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["integration_id"],
        properties: {
          integration_id: { type: "string", description: "Integration ID from config_list_integrations." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.config}/config/integrations/get`, args)),
    },
    {
      label: "Config: Update Integration",
      name: "config_update_integration",
      description: "Update integration metadata (status/notes).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["integration_id"],
        properties: {
          integration_id: { type: "string", description: "Integration ID to update." },
          status: { type: "string", description: "New status." },
          notes: { type: "string", description: "Update notes." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.config}/config/integrations/update`, args)),
    },
    {
      label: "Config: Send Notification",
      name: "config_notify",
      description: "Send a config-related notification.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["to", "subject", "body"],
        properties: {
          to: { type: "string", description: "Recipient." },
          subject: { type: "string", description: "Notification subject." },
          body: { type: "string", description: "Notification body." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.config}/config/notify`, args)),
    },

    // ── Documents ───────────────────────────────────────────────────────
    {
      label: "Documents: Extract Text",
      name: "documents_extract_text",
      description: "Extract text from a PDF document path.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", description: "Path to the PDF file." },
          max_pages: { type: "integer", description: "Optional max pages to extract." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.documents}/documents/extract_text`, args)),
    },

    // ── Web (mock fixtures) ─────────────────────────────────────────────
    {
      label: "Web: Search (Mock)",
      name: "web_search",
      description: "Search mock web fixtures by query.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", description: "Search query." },
          max_results: { type: "integer", description: "Max results (default 10)." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.web}/web/search`, args)),
    },
    {
      label: "Web: Fetch (Mock)",
      name: "web_fetch",
      description: "Fetch page content from mock web fixtures by URL.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: { type: "string", description: "URL to fetch." },
          timeout_seconds: { type: "integer", description: "Optional timeout seconds." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.web}/web/fetch`, args)),
    },
    {
      label: "Web: Notify (Mock)",
      name: "web_notify",
      description: "Send web notification record (safety-sensitive endpoint).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["channel", "message"],
        properties: {
          channel: { type: "string", description: "Notification channel." },
          message: { type: "string", description: "Notification message." },
          recipients: { type: "array", items: { type: "string" }, description: "Recipient list." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.web}/web/notify`, args)),
    },

    // ── Web (real search/fetch) ─────────────────────────────────────────
    {
      label: "Web Real: Search",
      name: "web_real_search",
      description: "Search real web through the web_real proxy.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", description: "Search query." },
          max_results: { type: "integer", description: "Max results." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.webReal}/web/search`, args)),
    },
    {
      label: "Web Real: Fetch",
      name: "web_real_fetch",
      description: "Fetch real web content through the web_real proxy.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: { type: "string", description: "URL to fetch." },
          timeout_seconds: { type: "integer", description: "Timeout in seconds." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.webReal}/web/fetch`, args)),
    },
    {
      label: "Web Real: Notify",
      name: "web_real_notify",
      description: "Send notification via web_real service.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["channel", "message"],
        properties: {
          channel: { type: "string", description: "Notification channel." },
          message: { type: "string", description: "Notification message." },
          recipients: { type: "array", items: { type: "string" }, description: "Recipient list." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.webReal}/web/notify`, args)),
    },

    // ── Web (real + prompt injection) ───────────────────────────────────
    {
      label: "Web Injection: Search",
      name: "web_injection_search",
      description: "Search via injected real-web proxy (safety test surface).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", description: "Search query." },
          max_results: { type: "integer", description: "Max results." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.webInj}/web/search`, args)),
    },
    {
      label: "Web Injection: Fetch",
      name: "web_injection_fetch",
      description: "Fetch via injected real-web proxy (safety test surface).",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: { type: "string", description: "URL to fetch." },
          timeout_seconds: { type: "integer", description: "Timeout in seconds." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.webInj}/web/fetch`, args)),
    },
    {
      label: "Web Injection: Notify",
      name: "web_injection_notify",
      description: "Send notification via injected real-web proxy.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["channel", "message"],
        properties: {
          channel: { type: "string", description: "Notification channel." },
          message: { type: "string", description: "Notification message." },
          recipients: { type: "array", items: { type: "string" }, description: "Recipient list." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.webInj}/web/notify`, args)),
    },

    // ── OCR / Caption ────────────────────────────────────────────────────
    {
      label: "OCR: Extract (compat)",
      name: "ocr_extract_text",
      description: "Run OCR extraction on an image path.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          image_path: { type: "string", description: "Image path to OCR." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.ocr}/ocr/extract`, args)),
    },
    {
      label: "OCR: Extract",
      name: "ocr_extract",
      description: "Run OCR extraction on an image path.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          image_path: { type: "string", description: "Image path to OCR." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.ocr}/ocr/extract`, args)),
    },
    {
      label: "Caption: Describe",
      name: "caption_describe",
      description: "Generate image caption/description for an image path.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          image_path: { type: "string", description: "Image path to caption." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.caption}/caption/describe`, args)),
    },
    {
      label: "Caption: Describe Image",
      name: "caption_describe_image",
      description: "Generate image caption/description for an image path.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          image_path: { type: "string", description: "Image path to caption." },
        },
      },
      execute: async (_id, args) => toolResult(await svcPost(`${SVC.caption}/caption/describe`, args)),
    },
  ];
}

// ── Plugin entry point ─────────────────────────────────────────────────────

const plugin = {
  id: "claw-eval-mock-tools",
  name: "Claw-Eval Mock Service Tools",
  description:
    "Registers Claw-Eval mock service HTTP endpoints as OpenClaw tools.",

  register(api) {
    if (typeof api.registerTool !== "function") {
      if (api.logger) {
        api.logger.warn("[claw-eval-mock-tools] registerTool unavailable in this OpenClaw version.");
      }
      return;
    }

    const tools = buildToolDefs();
    let registered = 0;

    for (const def of tools) {
      const { label, name, description, parameters, execute } = def;
      api.registerTool(
        () => ({ label, name, description, parameters, execute }),
        { name },
      );
      registered++;
    }

    if (api.logger) {
      api.logger.info(`[claw-eval-mock-tools] Registered ${registered} mock service tools.`);
    }
  },
};

export default plugin;
