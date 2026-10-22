/*
 * Compile-time checks for HrefOf: the hrefs a registered route pattern accepts. Vitest does not run
 * this file; `tsc -p packages/router/tsconfig.json` does, so a wrong type fails the typecheck.
 */
import type { HrefOf } from "../src/index";

/*
 * [PH-1] A literal tail after a param is kept. Only that tail, a `?` query or a `#` hash may follow.
 */
type Edit = HrefOf<"/posts/:id/edit">;
export const edit: Edit = "/posts/7/edit";
export const editQuery: Edit = "/posts/7/edit?tab=2";
export const editHash: Edit = "/posts/7/edit#top";
// @ts-expect-error [PH-1] the tail is /edit, not /delete
export const wrongTail: Edit = "/posts/7/delete";
// @ts-expect-error [PH-1] a query straight after the param skips the /edit tail
export const skippedTailQuery: Edit = "/posts/7?tab=2";
// @ts-expect-error [PH-1] a hash straight after the param skips the /edit tail
export const skippedTailHash: Edit = "/posts/7#top";
// @ts-expect-error [PH-1] a suffix glued to the tail with no separator is neither a query nor a hash
export const gluedSuffix: Edit = "/posts/7/editor";

/*
 * [PH-2] A static pattern takes itself, and only a `?` query or a `#` hash may follow it.
 */
type About = HrefOf<"/about">;
export const about: About = "/about";
export const aboutQuery: About = "/about?tab=2";
export const aboutHash: About = "/about#team";
// @ts-expect-error [PH-2] a further path segment is not a query or a hash
export const aboutSegment: About = "/about/team";
// @ts-expect-error [PH-2] a suffix glued to the path with no separator is refused
export const aboutGlued: About = "/aboutteam";

/*
 * [PH-3] A param-only pattern takes any text for the param, then a query or a hash.
 */
type Post = HrefOf<"/posts/:id">;
export const post: Post = "/posts/7";
export const postQuery: Post = "/posts/7?tab=2";
export const postHash: Post = "/posts/7#top";
// @ts-expect-error [PH-3] a plain string that matches no pattern is refused
export const postOther: Post = "/people/7";

/*
 * [PH-4] Two params with a literal segment between them keep that segment.
 */
type Nested = HrefOf<"/u/:id/posts/:post">;
export const nested: Nested = "/u/1/posts/2";
// @ts-expect-error [PH-4] the literal /posts segment is required
export const nestedWrong: Nested = "/u/1/comments/2";

/*
 * [PH-5] An optional param in the middle may be absent, and the literal tail after it stays required.
 */
type Optional = HrefOf<"/a/:slug?/b">;
export const withSlug: Optional = "/a/x/b";
export const withoutSlug: Optional = "/a/b";
// @ts-expect-error [PH-5] the literal /b tail is required when the optional param is present
export const optionalWrongTail: Optional = "/a/x/c";

/*
 * [PH-6] A splat takes the rest of the path, and a query or hash may follow it.
 */
type Files = HrefOf<"/files/*rest">;
export const file: Files = "/files/a/b/c";
export const fileHash: Files = "/files/a#top";
// @ts-expect-error [PH-6] a splat pattern does not match another prefix
export const fileOther: Files = "/other/a";

/*
 * [PH-7] The root takes itself, and only a query or a hash may follow it.
 */
type Root = HrefOf<"/">;
export const root: Root = "/";
export const rootQuery: Root = "/?tab=2";
// @ts-expect-error [PH-7] the root takes no further path
export const rootPath: Root = "/x";
