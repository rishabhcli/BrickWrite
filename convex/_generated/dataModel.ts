/* eslint-disable */
/**
 * STAND-IN FOR CONVEX CODEGEN — replace by running `npx convex dev`.
 *
 * `npx convex codegen` writes this file from `convex/schema.ts`. No Convex
 * account is logged in for this build, so it is hand-written to exactly the
 * shape the generator produces. It derives everything from the schema, so it
 * cannot describe a table the schema does not declare; running codegen
 * overwrites it with a byte-similar file and nothing downstream changes.
 */
import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  TableNamesInDataModel,
  SystemTableNames,
} from 'convex/server'
import type { GenericId } from 'convex/values'
import type schema from '../schema'

export type DataModel = DataModelFromSchemaDefinition<typeof schema>

export type TableNames = TableNamesInDataModel<DataModel>

export type Doc<TableName extends TableNames> = DocumentByName<DataModel, TableName>

export type Id<TableName extends TableNames | SystemTableNames> = GenericId<TableName>
