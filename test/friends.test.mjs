import test from "node:test";
import assert from "node:assert/strict";
import {
  addressedToMe,
  createFriendStore,
  describeParty,
  isValidEmail,
  partitionRequests,
  profileIdsFor,
  rejectionFor,
} from "../lib/friends.js";

const ME = { userId: "me", email: "alexi@example.com" };
const row = (overrides) => ({
  id: `r${Math.random().toString(36).slice(2, 7)}`,
  requester_id: "them",
  recipient_email: "alexi@example.com",
  recipient_id: null,
  status: "pending",
  created_at: "2026-09-21T10:00:00Z",
  ...overrides,
});

test("email validation accepts real addresses and rejects the rest", () => {
  for (const value of ["a@b.co", "Jordan.Lee+tag@example.com", "  spaced@example.org  "]) {
    assert.equal(isValidEmail(value), true, `${value} should be valid`);
  }
  for (const value of ["", "jordan", "jordan@", "@example.com", "jordan@example", "a b@example.com", null]) {
    assert.equal(isValidEmail(value), false, `${value} should be invalid`);
  }
});

test("a row addressed to my email or my id is mine", () => {
  assert.equal(addressedToMe(row({ recipient_email: "ALEXI@example.com" }), ME), true);
  assert.equal(addressedToMe(row({ recipient_email: "someone@else.com", recipient_id: "me" }), ME), true);
  assert.equal(addressedToMe(row({ recipient_email: "someone@else.com" }), ME), false);
  assert.equal(addressedToMe(row(), { userId: "me", email: "" }), false, "no email means no email match");
});

test("requests split into incoming, outgoing and friends", () => {
  const rows = [
    row({ id: "in1", requester_id: "them" }),
    row({ id: "out1", requester_id: "me", recipient_email: "jordan@example.com" }),
    row({ id: "friend1", requester_id: "me", recipient_id: "jordan", recipient_email: "jordan@example.com", status: "accepted" }),
    row({ id: "friend2", requester_id: "sam", recipient_id: "me", status: "accepted" }),
    row({ id: "declined", requester_id: "nope", status: "declined" }),
    row({ id: "other", requester_id: "x", recipient_email: "nothing@to.do", recipient_id: "y" }),
  ];
  const result = partitionRequests(rows, ME);
  assert.deepEqual(result.incoming.map((entry) => entry.id), ["in1"]);
  assert.deepEqual(result.outgoing.map((entry) => entry.id), ["out1"]);
  assert.deepEqual(result.friends.map((entry) => entry.id), ["friend1", "friend2"]);
  assert.deepEqual(result.friends.map((entry) => entry.friendId), ["jordan", "sam"]);
  assert.deepEqual(result.friends.map((entry) => entry.direction), ["sent", "received"]);
});

test("someone else's rows never show up as mine", () => {
  const rows = [row({ requester_id: "a", recipient_id: "b", recipient_email: "b@example.com", status: "accepted" })];
  const result = partitionRequests(rows, ME);
  assert.deepEqual([result.incoming, result.outgoing, result.friends], [[], [], []]);
});

test("duplicate requests from one person collapse to the newest", () => {
  const rows = [
    row({ id: "old", requester_id: "them", created_at: "2026-09-01T10:00:00Z" }),
    row({ id: "new", requester_id: "them", created_at: "2026-09-20T10:00:00Z" }),
  ];
  const result = partitionRequests(rows, ME);
  assert.deepEqual(result.incoming.map((entry) => entry.id), ["new"]);
});

test("rows with an unknown status are ignored", () => {
  assert.deepEqual(partitionRequests([row({ status: "banana" }), null], ME).incoming, []);
});

test("profile ids are collected from both sides without repeats", () => {
  const ids = profileIdsFor([row({ requester_id: "a", recipient_id: "b" }), row({ requester_id: "a", recipient_id: null })]);
  assert.deepEqual(ids.sort(), ["a", "b"]);
});

test("a row is described by the other person, not by me", () => {
  const profiles = { them: { display_name: "Jordan Lee", photo_url: "https://example.com/j.png" } };
  const incoming = describeParty(row({ requester_id: "them" }), { userId: "me", profiles });
  assert.equal(incoming.name, "Jordan Lee");
  assert.equal(incoming.photo, "https://example.com/j.png");

  const outgoing = describeParty(row({ requester_id: "me", recipient_email: "sam@example.com" }), { userId: "me", profiles: {} });
  assert.equal(outgoing.name, "sam@example.com", "before they sign up, the email stands in for a name");
  assert.equal(outgoing.pendingSignup, true);
});

test("the other party's email is never my own address", () => {
  // A request I received carries MY email in recipient_email. Reporting that
  // as the sender's address would make every lookup by email match me.
  const received = row({ requester_id: "them", recipient_email: "alexi@example.com", recipient_id: "me", status: "accepted" });
  const party = describeParty(received, { userId: "me", profiles: { them: { display_name: "Jordan Lee" } } });
  assert.equal(party.email, "", "no address is claimed for them");
  assert.equal(party.name, "Jordan Lee");
  assert.equal(party.id, "them");
  assert.equal(party.pendingSignup, false);

  const unknownSender = describeParty(received, { userId: "me", profiles: {} });
  assert.equal(unknownSender.name, "Someone");
  assert.equal(unknownSender.email, "");

  const sent = describeParty(row({ requester_id: "me", recipient_email: "JORDAN@Example.com" }), { userId: "me", profiles: {} });
  assert.equal(sent.email, "jordan@example.com", "an address I addressed it to is theirs, lower cased");
});

test("a request is refused when it makes no sense to send", () => {
  const rows = [
    row({ requester_id: "me", recipient_email: "waiting@example.com", status: "pending" }),
    row({ requester_id: "me", recipient_email: "already@example.com", status: "accepted" }),
    row({ requester_id: "me", recipient_email: "said-no@example.com", status: "declined" }),
  ];
  assert.match(rejectionFor("", { ...ME, rows }), /Enter an email/);
  assert.match(rejectionFor("nonsense", { ...ME, rows }), /does not look like/);
  assert.match(rejectionFor("ALEXI@example.com", { ...ME, rows }), /your own address/);
  assert.match(rejectionFor("waiting@example.com", { ...ME, rows }), /already have a request/);
  assert.match(rejectionFor("already@example.com", { ...ME, rows }), /already friends/);
  assert.equal(rejectionFor("said-no@example.com", { ...ME, rows }), null, "a declined request can be sent again");
  assert.equal(rejectionFor("new@example.com", { ...ME, rows }), null);
});

/** Records what the store asks the database to do. */
function stubClient(responses = {}) {
  const calls = [];
  const builder = (table, verb, payload) => {
    const record = { table, verb, payload, filters: {} };
    calls.push(record);
    const chain = {
      select: (columns) => {
        record.columns = columns;
        return chain;
      },
      in: (column, values) => {
        record.filters[column] = values;
        return chain;
      },
      eq: (column, value) => {
        record.filters[column] = value;
        return chain;
      },
      then: (resolve) => resolve(responses[`${table}:${verb}`] || { data: [], error: null }),
    };
    return chain;
  };
  return {
    calls,
    from: (table) => ({
      select: (columns) => builder(table, "select").select(columns),
      insert: (payload) => builder(table, "insert", payload),
      update: (payload) => builder(table, "update", payload),
      delete: () => builder(table, "delete"),
    }),
  };
}

test("the store sends, answers and withdraws requests", async () => {
  const client = stubClient();
  const store = createFriendStore(client);

  await store.send({ requesterId: "me", email: "  JORDAN@Example.com ", note: "hi" });
  assert.deepEqual(client.calls[0].payload, {
    requester_id: "me",
    recipient_email: "jordan@example.com",
    note: "hi",
    status: "pending",
  });

  await store.respond({ id: "r1", accept: true, userId: "me" });
  assert.equal(client.calls[1].payload.status, "accepted");
  assert.equal(client.calls[1].payload.recipient_id, "me", "accepting claims the row for my account");
  assert.ok(client.calls[1].payload.responded_at);
  assert.equal(client.calls[1].filters.id, "r1");

  await store.respond({ id: "r2", accept: false, userId: "me" });
  assert.equal(client.calls[2].payload.status, "declined");

  await store.withdraw("r3");
  assert.equal(client.calls[3].verb, "delete");
  assert.equal(client.calls[3].filters.id, "r3");
});

test("the store returns profiles keyed by id, and skips an empty lookup", async () => {
  const client = stubClient({
    "profiles:select": { data: [{ id: "a", display_name: "Ada" }, { id: "b", display_name: "Bo" }], error: null },
  });
  const store = createFriendStore(client);
  const { data } = await store.profiles(["a", "b"]);
  assert.deepEqual(data, { a: { id: "a", display_name: "Ada" }, b: { id: "b", display_name: "Bo" } });

  const empty = await store.profiles([]);
  assert.deepEqual(empty.data, {});
  assert.equal(client.calls.length, 1, "no query is made for an empty list");
});

test("a failed list surfaces the error instead of pretending it is empty", async () => {
  const client = stubClient({ "friend_requests:select": { data: null, error: { message: "denied" } } });
  const { data, error } = await createFriendStore(client).list();
  assert.deepEqual(data, []);
  assert.equal(error.message, "denied");
});
