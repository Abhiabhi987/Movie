-- Redis Lua script to atomically reserve multiple seats for a hold
-- Keys: screening:{id}:seat:{seat_external_id}
-- Args: hold_id, ttl_seconds, customer_id, timestamp

-- Behavior:
-- - Ensure all seats are in AVAILABLE state
-- - If yes, set each seat to HELD:{hold_id}:{expires_ts}
-- - Return JSON string: { success: true } or { success: false, conflicting: [seat ids] }

local cjson = require 'cjson'
local hold_id = ARGV[1]
local ttl = tonumber(ARGV[2])
local customer_id = ARGV[3]
local ts = ARGV[4]

local now = tonumber(ts)
local expires = now + ttl * 1000

local conflicting = {}
for i, key in ipairs(KEYS) do
  local v = redis.call('get', key)
  if not v or v == false then
    table.insert(conflicting, key)
  else
    if string.sub(v, 1, 9) ~= 'AVAILABLE' then
      -- not available
      table.insert(conflicting, key)
    end
  end
end

if #conflicting > 0 then
  return cjson.encode({ success = false, conflicting = conflicting })
end

for i, key in ipairs(KEYS) do
  local newv = 'HELD:' .. hold_id .. ':' .. tostring(expires)
  redis.call('set', key, newv)
  -- Optionally set a Redis TTL so it auto-expires. TTL in seconds from now.
  redis.call('expire', key, ttl)
end

return cjson.encode({ success = true })
