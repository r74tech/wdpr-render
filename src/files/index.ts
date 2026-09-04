import { handleFilesRequest, type FilesBindings } from "./worker";

export default {
	fetch: (request, env) => handleFilesRequest(request, env),
} satisfies ExportedHandler<FilesBindings>;
