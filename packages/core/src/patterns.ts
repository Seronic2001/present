// Patterns: whole slides to start from, one for each job a slide usually has. Each is ordinary slide
// source, composed only from public macros, cues and phrases, so an agent can read one to learn the
// grammar, and can change anything in it. The placeholder text says what belongs there.
export interface Pattern { doc: string; useWhen: string; source: string; }

const front = (title: string, brief: string, score: string) => `---\ntitle: ${title}\nbrief: ${brief}\nnotes: Replace with what you will say.\nscore:\n${score}---\n`;

export const PATTERNS: Record<string, Pattern> = {
  statement: {
    doc: 'A title or closing line alone on the slide.', useWhen: 'Opening, closing, or one sentence that must land.',
    source: `${front('The one idea', 'States the idea plainly.', '  intro:\n    - rise: sub\n      at: 700\n')}<Center>
  <Eyebrow>Your event</Eyebrow>
  <Title>The one idea, <em>said plainly</em></Title>
  <Sub id="sub">What the room should leave with.</Sub>
</Center>
`,
  },
  agenda: {
    doc: 'Milestones, one per step.', useWhen: 'An agenda, roadmap, or anything that happens in order.',
    source: `${front('The talk in four parts', 'Shows the order of the talk, one part at a time.', '  steps:\n    - over: .part\n      use: arrive\n')}<Header>The talk in <em>four parts</em></Header>
<Diagram viewBox="0 0 1600 560" alt="A rising line through four stops, each with a card">
  <Milestones id="plan" x="0" y="60" w="1600" h="440" rise="120" items="First|What this part covers;Second|What this part covers;Third|What this part covers;Fourth|What this part covers" />
</Diagram>
`,
  },
  contrast: {
    doc: 'Wrong answers struck out, then the right one.', useWhen: 'Correcting an assumption the room holds.',
    source: `${front('Not this, but that', 'Strikes out what people assume, then reveals what is true.', '  steps:\n    - name: strike the assumptions\n      cues:\n        - use: strike\n          on: .wrong\n          stagger: 240\n    - name: what is true\n      cues:\n        - use: appear\n          on: truth\n')}<Header>Not what you assumed, but <em>this</em></Header>
<Diagram viewBox="0 0 1600 560" alt="Three assumptions crossed out, and the true answer beside them">
  <Card x="0" y="0" w="760" h="540" tone="danger" label="What we assume" />
  <g class="wrong"><text class="st" x="72" y="170">First assumption</text><Strike class="strike" x1="60" x2="420" y="162" /><Badge class="badge" x="470" y="162" /></g>
  <g class="wrong"><text class="st" x="72" y="300">Second assumption</text><Strike class="strike" x1="60" x2="440" y="292" /><Badge class="badge" x="490" y="292" /></g>
  <g class="wrong"><text class="st" x="72" y="430">Third assumption</text><Strike class="strike" x1="60" x2="420" y="422" /><Badge class="badge" x="470" y="422" /></g>
  <Card id="truth" x="840" y="0" w="760" h="540" tone="accent" label="What is true"><text class="big" x="900" y="290">The real answer</text></Card>
</Diagram>
`,
  },
  flow: {
    doc: 'Boxes joined by Links, passing work along.', useWhen: 'A system, pipeline, or how something gets done.',
    source: `${front('How it works', 'Follows the work through the system, one handoff per step.', `  intro:
    - use: appear
      on: a
  steps:
    - name: first handoff
      cues:
        - use: appear
          on: b
        - use: handoff
          link: a-b
          to: b
    - name: second handoff
      cues:
        - use: appear
          on: c
        - use: handoff
          link: b-c
          to: c
      loop:
        every: 6000
        cues:
          - travel: a-b
          - travel: b-c
            at: 700
`)}<Header>How the work <em>moves</em></Header>
<Diagram viewBox="0 0 1600 420" alt="Three boxes joined left to right">
  <Box id="a" x="0" y="130" w="400" h="160" title="Input" sub="where it starts" />
  <Box id="b" x="600" y="130" w="400" h="160" tone="accent" title="The step that matters" sub="what it does" />
  <Box id="c" x="1200" y="130" w="400" h="160" title="Output" sub="where it ends" />
  <Link id="a-b" from="a" to="b" tone="accent" />
  <Link id="b-c" from="b" to="c" tone="accent" />
</Diagram>
`,
  },
  evidence: {
    doc: 'One chart making one claim, with its number.', useWhen: 'A result. Use real values from the references.',
    source: `${front('The result', 'Shows the measured change point by point, then states it.', `  steps:
    - over: .part
      use: arrive
    - name: the number
      cues:
        - use: appear
          on: claim
        - count: claim
`)}<Header>What the numbers <em>show</em></Header>
<Columns ratio="2.1:1">
  <Diagram viewBox="0 0 1040 520" alt="A line rising from the first measurement to the last">
    <Plot id="result" x="0" y="0" w="1040" h="510" points="0.52,0.81,0.95" labels="First,Second,Third" />
  </Diagram>
  <Center><Stat id="claim" value="+0.43" label="Replace with the measured change" /></Center>
</Columns>
`,
  },
  breakdown: {
    doc: 'Where the time or effort goes.', useWhen: 'Showing that the cost sits somewhere surprising.',
    source: `${front('Where the time goes', 'Builds the trace bar by bar, so the slow part arrives last.', '  intro:\n    - use: arrive\n      on: .part\n      stagger: 340\n')}<Header>Where the time <em>actually goes</em></Header>
<Diagram viewBox="0 0 1600 340" alt="Bars on a shared clock, the last and longest in red">
  <Timing id="trace" x="0" y="0" w="1600" label="Time from request" rows="First stage|0|2;Second stage|2|3;Third stage|5|2;The surprise|7|8|danger" />
</Diagram>
`,
  },
  boundary: {
    doc: 'One thing at the centre, with what is around it.', useWhen: 'What surrounds a system: its tools, risks, or stakeholders.',
    source: `${front('What surrounds it', 'Adds each surrounding part in turn, ending on what is blocked.', '  steps:\n    - over: .part\n      use: arrive\n')}<Header>What sits <em>around</em> it</Header>
<Diagram viewBox="0 0 1600 640" alt="A centre circle with five spokes, one marked blocked">
  <Hub id="core" x="800" y="310" r="240" label="The system" items="First|ok;Second|ok;Third|ok;Fourth|ok;Blocked|danger" />
</Diagram>
`,
  },
  gates: {
    doc: 'Plenty going in, little getting through.', useWhen: 'A bottleneck, a review process, or a funnel.',
    source: `${front('The bottleneck', 'Opens each gate in turn, then shows what flows through.', `  steps:
    - over: .part
      use: arrive
      loop:
        every: 4000
        cues:
          - use: flood
            path: pass-flow
`)}<Header>The <em>checkpoints</em> are the bottleneck</Header>
<Diagram viewBox="0 0 1600 600" alt="A wide channel narrowing through three gates and widening again">
  <Neck id="pass" x="0" y="0" w="1600" h="580" input="What goes in" output="What comes out" items="First gate|What it checks;Second gate|What it checks;Third gate|What it checks" />
</Diagram>
`,
  },
  search: {
    doc: 'A path climbing a contour map to a goal.', useWhen: 'Search, optimisation, or progress toward a goal.',
    source: `${front('Finding the way up', 'Brings up the landscape, then climbs it to the goal.', `  intro:
    - use: survey
  steps:
    - name: keep climbing
      cues:
        - hot: goal-note
      loop:
        every: 4000
        cues:
          - use: flood
            path: map-climb
`)}<Header>Set the goal, and let it <em>climb</em></Header>
<Diagram viewBox="0 0 1600 600" alt="Contour lines around a summit, with a path climbing to it">
  <Terrain id="map" x="100" y="0" w="1400" h="580" label="Goal" />
  <Label id="goal-note" x="100" y="40">The landscape</Label>
</Diagram>
`,
  },
};
