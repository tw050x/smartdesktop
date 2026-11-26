// What the website demo shows: Larder, a made-up grocery delivery business, planning its checkout.
// Each export is what an AI sends propose_schematic (see main/store.js), so the demo's store builds
// the same schematics the app would. Checkout is the one the story is about: proposed, commented on,
// revised and accepted. The rest are already there, in their domains, for it to embed and for home
// to list.

// What the AI names the demo's chat after its first reply (SmartDesktop's chat tab, see chat-window.js).
export const CHAT_TITLE = 'Plan the web checkout';

export const DOMAINS = { platform: 'Platform', orders: 'Orders', customers: 'Customers' };

export const SERVICE_AUTH = {
  domain: 'platform',
  name: 'Service auth',
  summary: 'How one service proves who it is to another, with short-lived tokens.',
  contract: '**Provides** a signed token for a named audience, valid for 5 minutes.\n\n**Needs** the calling service’s client id and secret.',
  parameters: [
    { name: 'audience', description: 'The service the token is for' },
  ],
  items: [
    {
      id: 'flow', kind: 'sequence', title: 'Token flow', description: 'A service asks for a token, then calls with it',
      participants: [{ id: 'caller', label: 'Calling service' }, { id: 'issuer', label: 'Token issuer' }, { id: 'callee', label: 'Called service' }],
      messages: [
        { id: 'ask', from: 'caller', to: 'issuer', label: 'client credentials' },
        { id: 'token', from: 'issuer', to: 'caller', label: 'token (5 min)', reply: true },
        { id: 'call', from: 'caller', to: 'callee', label: 'request + token' },
        { id: 'check', from: 'callee', to: 'issuer', label: 'check signature' },
      ],
    },
  ],
};

export const PAYMENTS = {
  domain: 'orders',
  name: 'Payments',
  summary: 'Takes card payments through the card provider, and refunds them.',
  contract: '**Provides** `POST /charges` and `POST /refunds`.\n\n**Promises** a charge is made at most once for each idempotency key.',
  items: [
    { id: 'notes', kind: 'document', title: 'How charges work', description: 'Idempotency and retries', markdown: '# How charges work\n\nEvery charge carries an idempotency key, so a retry never charges twice.' },
  ],
};

export const STOCK = {
  domain: 'orders',
  name: 'Stock',
  summary: 'What each store has, and what’s held for orders not yet picked.',
  contract: '**Provides** `POST /reservations`, holding items for 30 minutes.',
  items: [
    { id: 'rules', kind: 'document', title: 'Reservations', description: 'Holding and releasing items', markdown: '# Reservations\n\nA reservation holds items for 30 minutes, and is released when an order is cancelled.' },
  ],
};

export const NOTIFICATIONS = {
  domain: 'customers',
  name: 'Notifications',
  summary: 'Emails and texts to customers about their orders and deliveries.',
  contract: '**Provides** `POST /messages` for a customer and a template.',
  items: [
    { id: 'templates', kind: 'table', title: 'Templates', description: 'What can be sent', columns: [{ id: 'name', label: 'Template' }, { id: 'when', label: 'Sent when' }], rows: [{ id: 'confirmed', cells: { name: 'Order confirmed', when: 'An order is paid' } }, { id: 'out', cells: { name: 'Out for delivery', when: 'A driver sets off' } }] },
  ],
};

// Checkout, as the AI first proposes it: the goal the user gave it, then the schematic.
export const CHECKOUT_GOAL = 'the checkout for our web shop, from basket to paid order';
export const CHECKOUT_TITLE = 'Web checkout';

export const CHECKOUT = {
  domain: 'orders',
  name: 'Checkout',
  summary: 'Takes a customer from a full basket to a paid order, with its items held in stock.',
  contract: '**Provides** `POST /checkouts`, which returns an [order](fields).\n\n**Needs** a token from [Service auth](auth).\n\n**Promises**\n\n- A customer is charged at most once for an order.\n- A failed payment leaves stock untouched.',
  uses: [{ id: 'auth', schemaKey: 'serviceAuth', with: { audience: 'payments' } }],
  items: [
    {
      id: 'overview', kind: 'flow', title: 'Overview', description: 'The services a checkout goes through',
      nodes: [
        { id: 'web', label: 'Web shop', link: 'journey#pay' },
        { id: 'api', label: 'Checkout API', link: 'journey#submit' },
        { id: 'basket', label: 'Basket', link: 'rules#basket' },
        { id: 'pricing', label: 'Pricing', link: 'rules#pricing' },
        { id: 'payments', label: 'Payments', link: 'rules#payment' },
        { id: 'auth', label: 'Service auth', link: 'auth' },
        { id: 'orders', label: 'Orders', link: 'fields' },
        { id: 'stock', label: 'Stock', link: 'rules#stock' },
      ],
      edges: [
        { from: 'web', to: 'api', label: 'submits' },
        { from: 'api', to: 'basket', label: 'reads' },
        { from: 'api', to: 'pricing', label: 'prices' },
        { from: 'api', to: 'payments', label: 'charges', link: 'journey#charge' },
        { from: 'payments', to: 'auth', label: 'gets a token' },
        { from: 'api', to: 'orders', label: 'creates', link: 'journey#create' },
        { from: 'orders', to: 'stock', label: 'reserves' },
      ],
    },
    {
      id: 'journey', kind: 'sequence', title: 'Checkout journey', description: 'One checkout, from pressing Pay',
      participants: [
        { id: 'customer', label: 'Customer' },
        { id: 'web', label: 'Web shop' },
        { id: 'api', label: 'Checkout API' },
        { id: 'payments', label: 'Payments' },
        { id: 'orders', label: 'Orders' },
      ],
      messages: [
        { id: 'pay', from: 'customer', to: 'web', label: 'Pay now' },
        { id: 'submit', from: 'web', to: 'api', label: 'submit checkout', link: 'contract' },
        { id: 'charge', from: 'api', to: 'payments', label: 'charge card', link: 'rules#payment' },
        { id: 'charged', from: 'payments', to: 'api', label: 'charged', reply: true },
        { id: 'create', from: 'api', to: 'orders', label: 'create order', link: 'fields' },
        { id: 'done', from: 'api', to: 'web', label: 'order placed', reply: true },
      ],
    },
    {
      id: 'rules', kind: 'document', title: 'Business rules', description: 'What a checkout must always do',
      markdown: '# Business rules\n\n## Basket\n\nA checkout starts from the customer’s [basket](overview#basket), and the basket is locked until it ends.\n\n## Pricing\n\nPrices are fixed when the checkout starts and kept in the order’s [price](fields#price), so a price change mid-checkout never surprises anyone.\n\n## Payment\n\nThe card is charged once, with the checkout’s id as its idempotency key. A retry never charges twice.\n\n## Stock\n\nItems are reserved only after the payment succeeds. A failed payment leaves stock untouched.',
    },
    {
      id: 'fields', kind: 'table', title: 'Order fields', description: 'What an order holds',
      columns: [{ id: 'field', label: 'Field' }, { id: 'type', label: 'Type' }, { id: 'notes', label: 'Notes' }],
      rows: [
        { id: 'id', cells: { field: '`id`', type: 'uuid', notes: 'Made by [Orders](overview#orders)' } },
        { id: 'customer', cells: { field: '`customer`', type: 'uuid', notes: '' } },
        { id: 'items', cells: { field: '`items`', type: 'list', notes: 'Held by [Stock](overview#stock)' } },
        { id: 'price', cells: { field: '`price`', type: 'integer', notes: 'In pence, see [pricing](rules#pricing)' } },
        { id: 'status', cells: { field: '`status`', type: 'string', notes: 'Paid, picked or cancelled' } },
      ],
    },
  ],
};

// The user's comment on the first proposal, and what the AI changes for it.
export const COMMENT = { item: 'overview', part: 'payments', text: 'Is Payments ours, or the card provider we call?' };
export const REPLY = { text: 'Payments is ours: it calls the card provider. I’ve added the provider to the overview so the boundary is clear.', outcome: 'Actioned', noFurtherAction: true };

export const REVISION = {
  note: 'Shows the card provider Payments calls.',
  items: [
    {
      ...CHECKOUT.items[0],
      nodes: [...CHECKOUT.items[0].nodes, { id: 'provider', label: 'Card provider' }],
      edges: [...CHECKOUT.items[0].edges, { from: 'payments', to: 'provider', label: 'charges the card' }],
    },
  ],
};
