import fastifyMultipart from "@fastify/multipart";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { ValueError } from "@sinclair/typebox/errors";
import logger from "backend-lib/src/logger";
import prisma from "backend-lib/src/prisma";
import {
  InternalEventType,
  SegmentDefinition,
  SegmentNodeType,
  SubscriptionChange,
  SubscriptionGroupResource,
  UpsertSubscriptionGroupResource,
  UserUploadRow,
  WorkspaceId,
} from "backend-lib/src/types";
import {
  findUserIdsByUserProperty,
  InsertUserEvent,
  insertUserEvents,
} from "backend-lib/src/userEvents";
import csvParser from "csv-parser";
import { FastifyInstance } from "fastify";
import {
  SUBSRIPTION_GROUP_ID_HEADER,
  WORKSPACE_ID_HEADER,
} from "isomorphic-lib/src/constants";
import { schemaValidate } from "isomorphic-lib/src/resultHandling/schemaValidation";
import { omit } from "remeda";
import { Readable } from "stream";
import { v4 as uuid } from "uuid";

interface RowErrors {
  row: number;
  errors: ValueError[];
}

// eslint-disable-next-line @typescript-eslint/require-await
export default async function subscriptionGroupsController(
  fastify: FastifyInstance
) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().put(
    "/",
    {
      schema: {
        description: "Create or update a journey.",
        body: UpsertSubscriptionGroupResource,
        response: {
          200: SubscriptionGroupResource,
        },
      },
    },
    async (request, reply) => {
      const { id, name, type, workspaceId } = request.body;
      const segmentName = `subscriptionGroup-${id}`;
      const segmentDefinition: SegmentDefinition = {
        entryNode: {
          type: SegmentNodeType.SubscriptionGroup,
          id: "1",
          subscriptionGroupId: id,
        },
        nodes: [],
      };

      await prisma().$transaction([
        prisma().subscriptionGroup.upsert({
          where: {
            id,
          },
          create: {
            name,
            type,
            workspaceId,
            id,
          },
          update: {
            name,
            type,
          },
        }),
        prisma().segment.upsert({
          where: {
            workspaceId_name: {
              workspaceId,
              name: segmentName,
            },
          },
          create: {
            name: segmentName,
            workspaceId,
            definition: segmentDefinition,
            subscriptionGroupId: id,
            resourceType: "Internal",
          },
          update: {},
        }),
      ]);

      const resource: SubscriptionGroupResource = {
        id,
        name,
        workspaceId,
        type,
      };
      return reply.status(200).send(resource);
    }
  );

  await fastify.register(async (fastifyInner) => {
    await fastify.register(fastifyMultipart, {
      attachFieldsToBody: "keyValues",
    });

    fastifyInner.withTypeProvider<TypeBoxTypeProvider>().post(
      "/upload-csv",
      {
        schema: {
          // TODO upload files to S3 and use a presigned URL
          body: Type.Object({
            csv: Type.String(),
          }),
          headers: Type.Object({
            [WORKSPACE_ID_HEADER]: WorkspaceId,
            [SUBSRIPTION_GROUP_ID_HEADER]: Type.String(),
          }),
        },
      },
      async (request, reply) => {
        const csvStream = Readable.from(request.body.csv);
        const workspaceId = request.headers[WORKSPACE_ID_HEADER];
        const subscriptionGroupId =
          request.headers[SUBSRIPTION_GROUP_ID_HEADER];

        let rows: UserUploadRow[];
        // Parse the CSV stream into a JavaScript object with an array of rows
        try {
          rows = await new Promise<UserUploadRow[]>((resolve, reject) => {
            const parsingErrors: RowErrors[] = [];
            const uploadedRows: UserUploadRow[] = [];

            let i = 0;
            csvStream
              .pipe(csvParser())
              .on("data", (row) => {
                const parsed = schemaValidate(row, UserUploadRow);
                if (parsed.isOk()) {
                  uploadedRows.push(parsed.value);
                } else {
                  const errors = {
                    row: i,
                    errors: parsed.error,
                  };
                  logger().debug(
                    {
                      errors,
                      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                      row,
                    },
                    "failed to validate csv row"
                  );
                  parsingErrors.push(errors);
                }
                i += 1;
              })
              .on("end", () => {
                logger().debug(
                  `Parsed ${uploadedRows.length} rows for workspace: ${workspaceId}`
                );
                if (parsingErrors.length) {
                  reject(parsingErrors);
                } else {
                  resolve(uploadedRows);
                }
              })
              .on("error", (error) => {
                reject(error);
              });
          });
        } catch (e) {
          const errorResponse: {
            message: string;
            errors?: RowErrors[];
          } = {
            message: "misformatted file",
          };
          if (e instanceof Array) {
            errorResponse.errors = e as RowErrors[];
          }
          return reply.status(400).send(errorResponse);
        }

        const emailsWithoutIds: Set<string> = new Set<string>();

        for (const row of rows) {
          if (row.email && !row.id) {
            emailsWithoutIds.add(row.email);
          }
        }

        const missingUserIdsByEmail = await findUserIdsByUserProperty({
          userPropertyName: "email",
          workspaceId,
          valueSet: emailsWithoutIds,
        });

        const userEvents: InsertUserEvent[] = [];
        const timestamp = new Date().toISOString();

        for (const row of rows) {
          const userIds = missingUserIdsByEmail[row.email];
          const userId =
            (row.id as string | undefined) ??
            (userIds?.length ? userIds[0] : uuid());

          const identifyEvent: InsertUserEvent = {
            messageId: uuid(),
            messageRaw: JSON.stringify({
              userId,
              timestamp,
              type: "identify",
              traits: omit(row, ["id"]),
            }),
          };

          const trackEvent: InsertUserEvent = {
            messageId: uuid(),
            messageRaw: JSON.stringify({
              userId,
              timestamp,
              type: "track",
              event: InternalEventType.SubscriptionChange,
              properties: {
                subscriptionId: subscriptionGroupId,
                action: SubscriptionChange.Subscribe,
              },
            }),
          };

          userEvents.push(trackEvent);
          userEvents.push(identifyEvent);
        }
        await insertUserEvents({
          workspaceId,
          userEvents,
        });

        const response = await reply.status(200).send();
        return response;
      }
    );
  });
}
