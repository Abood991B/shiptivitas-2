import express from 'express';
import Database from 'better-sqlite3';

const app = express();

// The kanban board runs on the React dev server (localhost:3000), so the browser
// needs to be allowed to call this API on localhost:3001.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
});

app.use(express.json());

app.get('/', (req, res) => {
  return res.status(200).send({'message': 'SHIPTIVITY API. Read documentation to see API docs'});
});

// We are keeping one connection alive for the rest of the life application for simplicity
const db = new Database('./clients.db');

// Don't forget to close connection when server gets terminated
const closeDb = () => db.close();
process.on('SIGTERM', closeDb);
process.on('SIGINT', closeDb);

const VALID_STATUSES = ['backlog', 'in-progress', 'complete'];
// Board order of the swimlanes: backlog -> in-progress -> complete
const STATUS_SORT_ORDER = "case status when 'backlog' then 1 when 'in-progress' then 2 else 3 end";

/**
 * Validate id input
 * @param {any} id
 */
const validateId = (id) => {
  if (Number.isNaN(id)) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid id provided.',
      'long_message': 'Id can only be integer.',
      },
    };
  }
  const client = db.prepare('select * from clients where id = ? limit 1').get(id);
  if (!client) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid id provided.',
      'long_message': 'Cannot find client with that id.',
      },
    };
  }
  return {
    valid: true,
  };
}

/**
 * Validate status input
 * @param {any} status
 */
const validateStatus = (status) => {
  if (status === undefined || status === null) {
    return { valid: true };
  }
  if (!VALID_STATUSES.includes(status)) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid status provided.',
      'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
      },
    };
  }
  return { valid: true };
}

/**
 * Validate priority input
 * @param {any} priority
 */
const validatePriority = (priority) => {
  if (priority === undefined || priority === null || priority === '') {
    return { valid: true };
  }
  const numericPriority = Number(priority);
  if (!Number.isInteger(numericPriority) || numericPriority < 1) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid priority provided.',
      'long_message': 'Priority can only be positive integer.',
      },
    };
  }
  return {
    valid: true,
  };
}

/**
 * Every client on the board, ordered the same way the swimlanes are displayed.
 * GET /api/v1/clients
 */
const getAllClients = () => {
  return db
    .prepare(`select * from clients order by ${STATUS_SORT_ORDER}, priority asc, id asc`)
    .all();
}

/**
 * Clients of a single swimlane, top of the column first (priority 1 -> x).
 * @param {string} status
 */
const getSwimlane = (status) => {
  return db
    .prepare('select * from clients where status = ? order by priority asc, id asc')
    .all(status);
}

/**
 * Rewrite a swimlane so its clients are numbered 1..x from top to bottom.
 * Only issues an UPDATE for the rows whose position actually changed.
 * @param {string} status
 * @param {Array<object>} clients clients of that swimlane in their new order
 */
const persistSwimlane = (status, clients) => {
  const update = db.prepare('update clients set status = ?, priority = ? where id = ?');
  clients.forEach((client, index) => {
    const position = index + 1;
    if (client.status !== status || client.priority !== position) {
      update.run(status, position, client.id);
    }
  });
}

/**
 * Save a card drop coming from the frontend board.
 * Handles both acceptance criteria:
 *  - a card dropped into another swimlane gets the new status, is appended as the
 *    lowest priority when no priority is given, and its old swimlane is renumbered;
 *  - a card rearranged inside its own swimlane is inserted at the requested priority
 *    and the cards below it are pushed down.
 *
 * @param {number} id client id
 * @param {string} [status] 'backlog' | 'in-progress' | 'complete'
 * @param {number} [priority] 1 = top of the swimlane
 * @returns {boolean} true when the board was changed, false when there was nothing to do
 */
const saveClientPosition = (id, status, priority) => {
  const client = db.prepare('select * from clients where id = ? limit 1').get(id);
  const statusChanged = status !== undefined && status !== null && status !== client.status;
  const priorityProvided = priority !== undefined && priority !== null && priority !== '';

  // Same swimlane and no ordering requested -> nothing to persist.
  if (!statusChanged && !priorityProvided) {
    return false;
  }

  const oldStatus = client.status;
  const targetStatus = statusChanged ? status : oldStatus;
  const oldSwimlane = getSwimlane(oldStatus).filter((c) => c.id !== id);
  // The target swimlane without the dragged card, so it can be re-inserted cleanly.
  const targetSwimlane = targetStatus === oldStatus
    ? oldSwimlane
    : getSwimlane(targetStatus);

  let index;
  if (priorityProvided) {
    const requested = Number(priority);
    // Out of bounds priorities are clamped so a column always ends up with 1..x.
    index = Math.min(Math.max(requested, 1), targetSwimlane.length + 1) - 1;
  } else {
    // Moved to a new swimlane without an explicit spot -> put it at the bottom.
    index = targetSwimlane.length;
  }

  const reorderedTarget = targetSwimlane.slice();
  reorderedTarget.splice(index, 0, client);

  const applyChanges = db.transaction(() => {
    if (statusChanged) {
      persistSwimlane(oldStatus, oldSwimlane);
    }
    persistSwimlane(targetStatus, reorderedTarget);
  });
  applyChanges();

  return true;
}

/**
 * Get all of the clients. Optional filter 'status'
 * GET /api/v1/clients?status={status} - list all clients, optional parameter status: 'backlog' | 'in-progress' | 'complete'
 */
app.get('/api/v1/clients', (req, res) => {
  const status = req.query.status;
  if (status) {
    // status can only be either 'backlog' | 'in-progress' | 'complete'
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).send({
        'message': 'Invalid status provided.',
        'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
      });
    }
    const clients = getSwimlane(status);
    return res.status(200).send(clients);
  }
  return res.status(200).send(getAllClients());
});

/**
 * Get a client based on the id provided.
 * GET /api/v1/clients/{client_id} - get client by id
 */
app.get('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id , 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    return res.status(400).send(messageObj);
  }
  return res.status(200).send(db.prepare('select * from clients where id = ?').get(id));
});

/**
 * Update client information based on the parameters provided.
 * When status is provided, the client status will be changed
 * When priority is provided, the client priority will be changed with the rest of the clients accordingly
 * Note that priority = 1 means it has the highest priority (should be on top of the swimlane).
 * No client on the same status should not have the same priority.
 * This API should return list of clients on success
 *
 * PUT /api/v1/clients/{client_id} - change the status of a client
 *    Data:
 *      status (optional): 'backlog' | 'in-progress' | 'complete',
 *      priority (optional): integer,
 *
 */
app.put('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id , 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    return res.status(400).send(messageObj);
  }

  const { status, priority } = req.body || {};

  const statusCheck = validateStatus(status);
  if (!statusCheck.valid) {
    return res.status(400).send(statusCheck.messageObj);
  }
  const priorityCheck = validatePriority(priority);
  if (!priorityCheck.valid) {
    return res.status(400).send(priorityCheck.messageObj);
  }

  /* ---------- Update code below ----------*/

  saveClientPosition(id, status, priority);

  return res.status(200).send(getAllClients());
});

app.listen(3001);
console.log('app running on port ', 3001);
