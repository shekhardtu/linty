// Illustrative work only. Never use personal history in public product screenshots.
// Word counts and the app's estimates are calculated from these records.
export function websitePreviewData(now = Date.now()) {
  const examples = [
    { app: 'Mail', text: 'Thanks for walking me through the proposal. The revised timeline works for us. Let’s move ahead with the smaller first release and review the results together next Friday. I’ll send over the signed agreement this afternoon.' },
    { app: 'Notes', text: 'A thought for the next planning session: put the customer’s first successful action at the centre of onboarding. We can move the advanced settings to later. The goal for week one is to help someone finish a real task and feel ready to come back tomorrow.' },
    { app: 'Safari', text: 'The new search feels much clearer. One small suggestion: keep the filters visible after a search so people can change the date without starting again. I’ve added an example to the design review. Everything else is ready for the next round of feedback.' },
    { app: 'Mail', text: 'Here’s the recap from our conversation. We agreed on the launch checklist, the first set of customer interviews, and the owners for each task. Please add anything I missed before Thursday. I’ll bring the updated plan to our next meeting so we can make a decision together.' },
    { app: 'Notes', text: 'Tomorrow’s priorities: finish the introduction to the proposal, check the figures with the team, and leave an hour to review the customer feedback. Start with the introduction while the idea is still fresh. The smaller admin tasks can wait until the afternoon.' },
    { app: 'Safari', text: 'I can reproduce this when I change the date range after opening the detail view. The selection should stay on the same item. I’ve included the steps and the expected result below. Happy to try the next build and confirm whether the fix works.' },
    { app: 'Mail', text: 'It was lovely to catch up today. Your point about making the first step easier stayed with me. I’ve written down a few ideas and would love your thoughts when you have a moment. No rush at all; next week would be perfect.' },
    { app: 'Notes', text: 'Notes from the customer call: they want a quicker way to find last week’s updates and share a short summary with the team. We should test a simple search first, then decide whether saved views would actually help. Ask them to try it with their own project.' },
    { app: 'Mail', text: 'The draft is ready for your review. I’ve shortened the opening, clarified the next steps, and added the dates we discussed. Could you focus on the second section? That’s where I’m least sure the explanation is clear. We can talk through your comments tomorrow morning.' },
    { app: 'Notes', text: 'An idea to come back to: leave a little space at the end of each week to write down what changed and why. A few useful sentences will be easier to find later than a long meeting recording. Keep it simple enough that everyone can contribute.' },
    { app: 'Safari', text: 'This would be a useful addition to the next release. I’d start with a clear label and a keyboard shortcut, then see how people use it before adding more options. The current flow is already easy to understand, so let’s keep that quality as we build on it.' },
    { app: 'Mail', text: 'Thanks for the careful review. I’ve addressed the comments and left a short explanation beside the two decisions that still need discussion. Everything else is ready to go. If the revised version looks good, I’ll share it with the wider team after our check-in.' },
  ];
  const apps = { Mail: 'com.apple.mail', Notes: 'com.apple.Notes', Safari: 'com.apple.Safari' };
  const perDay = [6, 9, 13, 8, 12, 10, 11];
  let sequence = 0;
  const transcripts = perDay.flatMap((count, day) => Array.from({ length: count }, (_, index) => {
    const example = examples[(sequence++) % examples.length];
    const wordCount = example.text.trim().split(/\s+/).length;
    return {
      transcriptId: `website-example-${day}-${index}`,
      finalText: example.text,
      rawText: example.text,
      corrected: false,
      timestamp: now - day * 86400000 - index * 30 * 60000,
      wordCount,
      durationSeconds: Math.round(wordCount / (132 + index % 5 * 3) * 60),
      processingTimeMs: 1100 + index % 4 * 180,
      sttTimeMs: 1100 + index % 4 * 180,
      correctionTimeMs: 0,
      engine: 'local',
      modelName: 'Whisper Large Turbo Q5',
      application: { name: example.app, bundleId: apps[example.app] },
    };
  }));
  return transcripts;
}
