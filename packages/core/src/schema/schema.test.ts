import { test } from "vitest";

import { createSchema, createTable } from "./schema";

// This may be in a museum one day
// We like this one!!
// const schema = createSchema([
//   createTable("share")
//     .addColumn("id", "string")
//     .addColumn("name", "string")
//     .addColumn(
//       "usernames",
//       "string",
//       { optional: true, list: true }
//     ),
//   createTable("account")
//     .addColumn("id", "string")
//     .addColumn("name", "string")
//     .addColumn("shareId", "string", { references: "share.id" }),
// ]);

test("create schema", () => {
  createSchema([
    createTable("name").addColumn("id", "bigint").addColumn("age", "int"),
  ]);
});

test("references", () => {
  createSchema([
    createTable("Person").addColumn("id", "string").addColumn("age", "int"),
    createTable("Dog")
      .addColumn("id", "string")
      .addColumn("owner", "string", { references: "Person.id" }),
  ]);
});
