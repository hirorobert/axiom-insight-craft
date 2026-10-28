import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { expect, it } from "vitest";
const source=readFileSync(resolve(process.cwd(),"supabase/migrations/20261205100000_fs_equipment_preparation.sql"),"utf8");
it("matches the candidate byte for byte",()=>{
  expect(source).toBe(readFileSync(resolve(process.cwd(),"release/candidates/guided-equipment-r1/workpaper.sql"),"utf8"));
});
it("changes only the outer transaction statements from the approved unapplied source",()=>{
  const lines=source.split("\n");
  const reconstructed=[...lines.slice(0,2),"BEGIN;",...lines.slice(2,-1),"COMMIT;", ""].join("\n");
  expect(createHash("sha256").update(reconstructed,"utf8").digest("hex")).toBe("b6bbf88d56dca05325e84f368fdc333519a7d3546adce91475511bf31db981da");
});
it("does not supply an outer transaction to the native migrator",()=>{
  expect(source.split("\n").filter(l=>/^(BEGIN|COMMIT|ROLLBACK);$/.test(l))).toEqual([]);
});
