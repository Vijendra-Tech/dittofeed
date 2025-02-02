import {
  CompletionStatus,
  MessageTemplateResource,
  TemplateResourceType,
} from "isomorphic-lib/src/types";
import { Result } from "neverthrow";
import { GetServerSideProps } from "next";
import { validate } from "uuid";

import {
  buildNodesIndex,
  defaultEdges,
  defaultNodes,
} from "../../../components/journeys/defaults";
import { journeyToState } from "../../../components/journeys/store";
import { addInitialStateToProps } from "../../../lib/addInitialStateToProps";
import prisma from "../../../lib/prisma";
import { requestContext } from "../../../lib/requestContext";
import { PreloadedState, PropsWithInitialState } from "../../../lib/types";

export type JourneyGetServerSideProps =
  GetServerSideProps<PropsWithInitialState>;

export const journeyGetServerSideProps: JourneyGetServerSideProps =
  requestContext(async (ctx, dfContext) => {
    // Dynamically import to avoid transitively importing backend config at build time.
    const [{ toJourneyResource }, { toSegmentResource }] = await Promise.all([
      import("backend-lib/src/journeys"),
      import("backend-lib/src/segments"),
    ]);

    const id = ctx.params?.id;

    if (typeof id !== "string" || !validate(id)) {
      return {
        notFound: true,
      };
    }

    const workspaceId = dfContext.workspace.id;
    const [journey, segments, emailTemplates] = await Promise.all([
      await prisma().journey.findUnique({
        where: { id },
      }),
      prisma().segment.findMany({
        where: {
          workspaceId,
          resourceType: {
            not: "Internal",
          },
        },
      }),
      prisma().emailTemplate.findMany({
        where: { workspaceId },
      }),
    ]);

    const templateResources: MessageTemplateResource[] = emailTemplates.map(
      ({
        workspaceId: templateWorkspaceId,
        id: templateId,
        name,
        from,
        subject,
        body,
      }) => ({
        type: TemplateResourceType.Email,
        workspaceId: templateWorkspaceId,
        id: templateId,
        name,
        from,
        subject,
        body,
      })
    );

    const serverInitialState: PreloadedState = {
      messages: {
        type: CompletionStatus.Successful,
        value: templateResources,
      },
    };

    const journeyResourceResult = journey && toJourneyResource(journey);
    if (journeyResourceResult?.isOk()) {
      const journeyResource = journeyResourceResult.value;
      serverInitialState.journeys = {
        type: CompletionStatus.Successful,
        value: [journeyResource],
      };
      const stateFromJourney = journeyToState(journeyResource);
      Object.assign(serverInitialState, stateFromJourney);
    } else {
      serverInitialState.journeyName = `New Journey - ${id}`;
      serverInitialState.journeyNodes = defaultNodes;
      serverInitialState.journeyEdges = defaultEdges;
      serverInitialState.journeyNodesIndex = buildNodesIndex(defaultNodes);
    }

    const segmentResourceResult = Result.combine(
      segments.map(toSegmentResource)
    );

    if (segmentResourceResult.isOk()) {
      const segmentResource = segmentResourceResult.value;
      serverInitialState.segments = {
        type: CompletionStatus.Successful,
        value: segmentResource,
      };
    }

    const props = addInitialStateToProps({
      serverInitialState,
      props: {},
      dfContext,
    });

    return {
      props,
    };
  });
