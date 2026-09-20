from pathlib import Path
import argparse, hashlib, json, math, subprocess, wave

parser = argparse.ArgumentParser(description='Generate original synthetic English speech for capacity testing on macOS.')
parser.add_argument('directory', type=Path)
root = parser.parse_args().directory.resolve()
root.mkdir(parents=True, exist_ok=True)
clips = root / 'audio'
clips.mkdir(exist_ok=True)
paragraphs = [
"The design team reviewed the new navigation this morning. We agreed that the most common tasks should remain easy to find, even when someone opens the application for the first time. Clear labels and predictable spacing will help people move between their recent work and the settings they need. The next review will include a smaller window and a larger text size.",
"At the library, volunteers are preparing a collection of local stories. Each contributor will describe a place that matters to them and explain how it has changed. The recordings will become written accounts that can be searched by topic. Before publishing anything, the team will ask each speaker to review the transcript and confirm that the meaning has been preserved.",
"Our walking route begins beside the river and continues through a quiet residential neighborhood. There is a shaded garden near the bridge where we can stop for water. If the afternoon becomes too warm, we will use the shorter path through the park. Everyone should bring comfortable shoes and leave enough time to return before the evening train departs.",
"The workshop will begin with a short introduction to practical observation. Participants will sketch an everyday object, describe how it works, and identify one feature that could be improved. The purpose is to notice details that are usually overlooked. We will compare the different suggestions at the end and choose a small experiment that can be completed during the following week.",
"I would like to organize the project notes around decisions rather than meetings. Each entry should explain the question, the alternatives we considered, and the reason for the final choice. A new colleague should be able to understand the background without asking several people for the same explanation. Related drawings and examples can be linked from the relevant entry.",
"The community kitchen is testing a seasonal menu with ingredients from nearby farms. This week the cooks are comparing several ways to roast vegetables while keeping their texture. They will also prepare a simple soup that can be adapted for different dietary needs. Feedback from the first group of visitors will guide the menu for the next open day.",
"The morning train was delayed, so I used the extra time to review the conference schedule. There are sessions about accessible software, reliable systems, and clear communication. I plan to attend the smaller discussion groups because they allow more questions. After lunch, I will meet the other participants near the entrance and compare what we learned during the morning.",
"Our garden needs a better watering plan before the warmer weather arrives. The younger plants require regular attention, while established trees can tolerate longer dry periods. We will label the different areas and keep a simple record of rainfall. The aim is to use less water while making sure that new growth remains healthy throughout the summer months.",
"The research interview should start with open questions about the participant's usual routine. We should listen carefully before asking about specific features or problems. It is helpful to request an example from a recent experience, since general opinions can hide important details. After the conversation, we will separate direct observations from interpretations and discuss where more evidence is needed.",
"The museum is preparing an exhibition about the history of everyday tools. Visitors will be able to compare older objects with their modern equivalents and see which ideas have remained useful. The labels should explain the purpose of each object in ordinary language. A separate listening area will provide spoken descriptions for people who prefer to hear the information.",
"I have drafted a message about the schedule change. The opening sentence explains what is different, followed by the revised deadline and the person to contact with questions. I removed the background details that were already shared in the previous update. Before sending it, I will check that the dates are consistent and that the next action is clear.",
"The bicycle repair class will cover basic maintenance that people can perform at home. We will begin with tire pressure, brake inspection, and cleaning the chain. More complicated repairs should be handled by a qualified mechanic. Each participant will receive a short checklist and have time to practice the routine on their own bicycle before the session ends.",
"During the planning meeting, we discussed how to make progress visible without adding unnecessary reporting. A short weekly note can describe completed work, current questions, and anything that needs help. The format should stay simple enough that people actually use it. We will review the approach after a trial period and remove any part that creates work without helping decisions.",
"The landscape changes gradually as the trail climbs above the forest. Low shrubs replace the taller trees, and the path becomes more exposed to wind. We should check the weather before leaving and carry an extra layer even if the valley feels warm. The final viewpoint is optional, so nobody needs to continue beyond a comfortable distance.",
"A clear introduction helps readers decide whether a document is relevant to them. It should state the practical question and describe the result they can expect. Detailed background can follow once that purpose is understood. Examples are especially useful when an abstract idea could have several meanings, because they give everyone a common situation to discuss and improve.",
"The neighborhood book group has chosen a collection of short essays for its next meeting. Members can read the whole collection or select a few pieces that interest them. We will focus on how the writers build their arguments and use personal experience. The discussion should leave room for different interpretations rather than trying to find a single correct response.",
"We are testing the search experience with familiar words, unusual spellings, and empty results. A helpful interface should explain what happened and suggest a useful next step. It should also preserve the query when someone opens a result and then returns. These small details make the feature feel dependable, particularly when a person is trying to find something quickly.",
"The recording room has soft wall panels and a heavy curtain near the window. These materials reduce reflections and make spoken words easier to understand. Before an interview, we will listen to a short sample through headphones and check for background noise. The speaker should sit at a comfortable distance from the microphone and use their normal conversational voice.",
"The team is preparing instructions for people who will try the prototype next week. Each task should describe a goal without naming the controls needed to complete it. That allows us to see whether the interface explains itself. Observers will note moments of hesitation and ask follow up questions afterward, while avoiding hints that might change the participant's behavior.",
"On Saturday we will visit the farmers market early, when the stalls are less crowded. I want to buy fresh bread, tomatoes, and herbs for dinner. We can decide on the rest of the meal after seeing what is available. If the weather stays clear, we will take the long route home through the old part of town.",
"A useful progress report explains both achievements and uncertainty. It should make clear which results have been measured and which ideas still need testing. When a number changes, readers need enough context to understand whether the difference matters. We should avoid presenting a precise estimate as a promise when the evidence only supports a rough expectation for one situation.",
"The music teacher suggested practicing a difficult passage slowly before increasing the speed. Repeating the whole piece can make it harder to notice where a mistake begins. Short focused sessions allow the player to correct the movement and listen carefully to the result. A brief recording at the end can help compare progress without relying entirely on memory.",
"Our shared calendar should contain commitments that affect other people, while personal reminders can stay in individual task lists. This distinction makes the schedule easier to scan and reduces unnecessary notifications. If a meeting changes, the organizer should update the original invitation and explain the reason. People can then make a decision using the same current information.",
"The restoration project will preserve the character of the old building while improving access and comfort. The entrance needs a gentler approach, and the interior lighting should make signs easier to read. The designers will document original materials before starting work. Where a feature must be replaced, they will explain the choice and keep a record for future maintenance.",
"The science club is building simple experiments around temperature and evaporation. Students will predict what happens, record their observations, and compare the outcome with their initial explanation. The equipment should be safe and easy to obtain. A surprising result is a useful opportunity to ask another question, rather than something that needs to be hidden or dismissed.",
"I want the application to remember my place when I move between pages. A half written note should remain available, and a selected filter should not reset unexpectedly. At the same time, unfinished private text should not be stored permanently without a clear reason. The design needs to distinguish temporary working context from information the person has deliberately saved.",
"The coastal village has a small harbor surrounded by workshops and cafes. Fishing boats return in the early afternoon, and the promenade becomes busy as people stop to watch. Beyond the main street there is a quiet path toward the lighthouse. We can walk there after lunch and take photographs if the light remains clear enough to see the headland.",
"Before releasing a change, we should test the complete sequence that people will use. A component may work correctly by itself while failing when connected to another part of the system. Long operations deserve particular attention because interruptions become more likely as time passes. The result should remain recoverable, and the interface should explain what is happening without creating unnecessary distraction.",
"The volunteer coordinator asked for a shorter registration form. We should request only the information needed to arrange the activity and explain why each question is included. Optional details can be collected later when they become useful. After registration, the confirmation should include the location, arrival time, and a straightforward way to change plans or contact the organizer.",
"At the end of the day, I will review the notes and identify the decisions that still need an answer. Some tasks can be completed immediately, while others depend on information from another person. Writing down those dependencies makes tomorrow's priorities easier to choose. I also want to leave a clear stopping point so that returning to the work feels manageable."
]
numbers = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split()
numbers += ['twenty ' + n for n in numbers[:9]] + ['thirty']
markers = ['amber mountain','silver harbor','green lantern','blue meadow','copper forest','yellow orchard','purple valley','white compass','orange garden','golden river','quiet willow','gentle ocean','bright maple','scarlet bridge','velvet canyon','crystal lake','wooden castle','hidden island','spring blossom','winter feather','summer meadow','autumn lantern','distant mountain','open harbor','little garden','ancient forest','morning river','evening valley','silver compass','final lighthouse']
meta = []
for index in range(30):
    stem = clips / f'part-{index + 1:02d}'
    text = f'Section {numbers[index]}. ' + paragraphs[index] + ' ' + paragraphs[(index + 13) % 30] + f' The closing marker is {markers[index]}.'
    stem.with_suffix('.txt').write_text(text)
    rate = 145
    while True:
        subprocess.run(['say', '-v', 'Samantha', '-r', str(rate), '-f', str(stem.with_suffix('.txt')), '-o', str(stem.with_suffix('.aiff'))], check=True)
        wav_path = stem.with_suffix('.wav')
        wav_path.unlink(missing_ok=True)
        subprocess.run(['afconvert', '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', str(stem.with_suffix('.aiff')), str(wav_path)], check=True)
        with wave.open(str(wav_path), 'rb') as w:
            assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (16000, 1, 2)
            frames = w.readframes(w.getnframes())
        seconds = len(frames) / 32000
        if seconds <= 59.25: break
        rate = math.ceil(rate * seconds / 58.5)
    # Place a complete reference segment into every exact one-minute window.
    # Report the silence padding so timings cannot be mistaken for continuous speech.
    frames += b'\0' * (60 * 32000 - len(frames))
    with wave.open(str(wav_path), 'wb') as w:
        w.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        w.writeframes(frames)
    stem.with_suffix('.aiff').unlink()
    meta.append({'section':index+1, 'text':text, 'marker':markers[index], 'speech_seconds':seconds, 'padding_seconds':60-seconds, 'voice_rate':rate})
    print(f'Prepared minute {index+1}: {seconds:.1f}s speech, {60-seconds:.1f}s padding', flush=True)
    if index+1 in [1, 5, 10, 20, 30]:
        prefix = clips / f'{index+1:02d}min'
        with wave.open(str(prefix.with_suffix('.wav')), 'wb') as out:
            out.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            for n in range(index+1):
                with wave.open(str(clips / f'part-{n+1:02d}.wav'), 'rb') as part:
                    out.writeframes(part.readframes(part.getnframes()))
        prefix.with_suffix('.txt').write_text('\n\n'.join(m['text'] for m in meta))
        prefix.with_suffix('.json').write_text(json.dumps({'duration_seconds':(index+1)*60, 'voice':'Samantha', 'synthetic':True, 'sections':meta, 'sha256':hashlib.sha256(prefix.with_suffix('.wav').read_bytes()).hexdigest()}, indent=2))
(root / 'corpus.json').write_text(json.dumps(meta, indent=2))
print('Audio corpus ready.', flush=True)
