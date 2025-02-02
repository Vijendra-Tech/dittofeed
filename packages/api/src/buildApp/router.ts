import { FastifyInstance } from "fastify";

import contentController from "../controllers/contentController";
import debugController from "../controllers/debugController";
import eventsController from "../controllers/eventsController";
import indexController from "../controllers/indexController";
import journeysController from "../controllers/journeysController";
import segmentsController from "../controllers/segmentsController";
import settingsController from "../controllers/settingsController";
import subscriptionGroupsController from "../controllers/subscriptionGroupsController";
import userPropertiesController from "../controllers/userPropertiesController";
import usersController from "../controllers/usersController";
import webhooksController from "../controllers/webhooksController";
import requestContext from "./requestContext";

export default async function router(fastify: FastifyInstance) {
  // endpoints with standard authorization
  await fastify.register(
    async (f: FastifyInstance) => {
      await fastify.register(requestContext);

      await Promise.all([
        f.register(journeysController, { prefix: "/journeys" }),
        f.register(segmentsController, { prefix: "/segments" }),
        f.register(settingsController, { prefix: "/settings" }),
        f.register(contentController, { prefix: "/content" }),
        f.register(eventsController, { prefix: "/events" }),
        f.register(usersController, { prefix: "/users" }),
        f.register(userPropertiesController, { prefix: "/user-properties" }),
        f.register(subscriptionGroupsController, {
          prefix: "/subscription-groups",
        }),
      ]);
    },
    { prefix: "/api" }
  );

  // endpoints without standard authorization
  await fastify.register(
    async (f: FastifyInstance) => {
      await Promise.all([
        f.register(indexController),
        f.register(webhooksController, { prefix: "/webhooks" }),
      ]);
    },
    { prefix: "/api" }
  );

  await fastify.register(
    async (f: FastifyInstance) =>
      Promise.all([f.register(debugController, { prefix: "/debug" })]),
    { prefix: "/internal-api" }
  );
}
