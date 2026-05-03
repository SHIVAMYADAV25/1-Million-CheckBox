// Total checkboxes.  1_000_000 bits = 125 KB in Redis — very compact.
export const CHECKBOX_COUNT = 1_000_000;

// Redis key for the bitmask
export const BITMASK_KEY = "checkbox:bits";

// Redis Pub/Sub channel name
export const PUBSUB_CHANNEL = "internal:checkbox:change";

// Rate limiting window in seconds
export const RATE_LIMIT_WINDOW = 10; // 10-second rolling window

// Max events per window per socket
export const RATE_LIMIT_MAX = 15;