interface SitesAssets { fetch(request: Request): Promise<Response> }
interface SitesEnvironment { ASSETS: SitesAssets }

export default {
  async fetch(request: Request, environment: SitesEnvironment): Promise<Response> {
    const response = await environment.ASSETS.fetch(request);
    if (response.status !== 404) return response;
    const fallback = new URL('/', request.url);
    return environment.ASSETS.fetch(new Request(fallback, request));
  },
};
