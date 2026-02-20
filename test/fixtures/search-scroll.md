# Search Scroll Test Document

This document is used for E2E testing of content search and scroll.

## Section One

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.

Paragraph two of section one. This contains some filler text to make the document long enough to require scrolling. We need enough content so that later sections are below the fold.

## Section Two

More filler content here. The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump.

Additional paragraph in section two with more content to extend the document length and ensure scrolling is necessary for lower sections.

## Section Three

This section also has filler content. The purpose is to push the target section far enough down that scrolling must occur.

Another paragraph. We continue adding content to extend the vertical length of the rendered document significantly.

## Section Four

Yet another section of filler content. Building up the document to a sufficient length for scroll testing purposes.

More text in section four. Every section adds height to push the search target further below the initial viewport.

## Section Five

Additional filler section. The document needs to be long enough that the target keyword is not visible on initial render.

Continuing with more text. Various paragraphs of content that are not related to the search target.

## Section Six

More placeholder content. This section does not contain the special keyword we are looking for in our test.

Extra paragraph for added length. We want to make absolutely sure the target is off-screen.

## Section Seven

Approaching the end of filler content. The next section will contain the actual target for our search test.

Final filler paragraph before the target section appears in the document.

## Section Eight

This section is the padding section before the search target.

It contains general content but not the special marker.

## Section Nine

More general content in section nine to add document length.

Almost there - the target section is coming up next.

## Section Ten

This section provides the final padding before the search target.

We are close to the bottom of the document now.

## Target Section

This is the UNIQUE_SEARCH_TARGET_MARKER section. If the search scroll works correctly, the viewer should scroll down to this specific location when a user searches for this unique phrase and clicks the result.

The marker text appears only here and nowhere else in the document, making it ideal for verifying scroll behavior.

## Final Section

This is the last section of the document. It appears after the target to confirm we scrolled to the right place and not past it.

End of test document.
