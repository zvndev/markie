// A 2,048-word subset of the EFF large wordlist (4 to 6 letters, evenly spaced).
// Source: https://www.eff.org/dice, by the Electronic Frontier Foundation, CC BY 3.0 US.
// Each word adds exactly 11 bits when chosen uniformly at random.
export const PASSPHRASE_WORDS: readonly string[] = Object.freeze((
  "abacus abide ablaze abroad absurd accent acid acorn acre action active acts affair affirm affix aflame afloat " +
  "afoot aged agency agent aghast agile agony agreed ahead aide aids ajar album alias alibi alike alive almost " +
  "aloft aloha alone alto alumni amaze amber ambush amid amigo amino among amount ample amuck amulet amused " +
  "anchor anemia anemic anger angled angler animal anime annex anthem antics antsy anvil anyhow anyway aorta " +
  "apache apple apply april aptly aqua area argue arise armed arming armory aroma arose around arrest arrive " +
  "arson ascent ashen ashes aside askew asleep aspire astute atlas atop atrium attain attest attic audio august " +
  "author avatar avenge avenue avid avoid await award aware awhile awoke awry axis babied baboon backer backup " +
  "bacon badge badly baffle bagful bagged baggie baked bakery baking bamboo banana banish banked banker banner " +
  "barbed barber barley barman barn bash basics basil basis basket batboy bath baton bats bauble blade blah blank " +
  "blast blazer bleak bleep bless blimp bling blip blitz blob blot blouse bluff blunt blurb blurry blush boat " +
  "bobbed bobcat body boggle bogus boil bonded boned boney bonsai bonus bony booted booth bootie boozy borax " +
  "boring botany botch both bottom bounce bovine boxcar boxer boxy breach breath breezy briar bribe bride bright " +
  "brim brink broken broker bronze brook broom brunch brunt brute bubble bubbly bucket buckle buddy buffed buffer " +
  "buggy bulge bulgur bulk bunch bundle bungee bunny bunt busboy busily bust cabana cabbie cable cackle cacti " +
  "cactus caddy cadet cage calm cameo camera campus canal canary candle candy cane canned cannon canola canon " +
  "canopy cape capped carat carded caress cargo carol carrot carry carton carve case casing casino catchy catnap " +
  "catnip cattle catty caucus cause caviar cavity celery celtic cement chafe chain chair change chant chaos charm " +
  "chase chatty cheek cheer cheesy chef chemo chess chest chevy chewy chief chili chimp chip chirpy choice chomp " +
  "choosy chosen chrome chuck chug chummy chunk churn chute cinch cinema circle citric citrus city civil clad " +
  "claim clamor clamp clang clasp class claw clay clean cleat cleft clench clever client cling clip clique cloak " +
  "clone cloud clover clumsy clunky coach coat cobalt cocoa coerce coffee coke cola cold collie colony colt come " +
  "comfy comic comma common compel conch concur cope copied copier copper copy coral cornea corned corner corral " +
  "corset cortex cosmos cost cotton cough could county cozily cozy crafty cramp crane crate crave crayon crazy " +
  "crease create creed creme creole crept crib cried crimp cringe crispy crock crook crop cross crouch crown " +
  "crumb crummy crux crying cube cuddly cupid cupped cure curfew curing curler curly curry cursor curtly curve " +
  "curvy cushy cussed cycle cyclic dagger daily dainty daisy dance dander danger dangle dares dart dash dating " +
  "dawn daybed dealer dealt dean debit debtor debug decade decaf decal deceit decent deck decoy decree deduce " +
  "deed deem deeply deface defame defile define defog defuse defy degree delay delete delta deluxe demise demote " +
  "denim denote dense deny depict deport depose depth derail derby detail deuce device dial diary dice dicing " +
  "dilute dime dimly dimmer dimple diner dingo dingy dinner dipped dipper dish disk dismay ditch ditto ditzy " +
  "dizzy doable docile dodge dodgy doily dole dollar dolly domain donor doodle doozy dork dosage dose dotted dove " +
  "down dowry drab drank draw dreamy dreary drench drew dried drift drippy driven drone drool droop drown drudge " +
  "drum ducky duct dude dugout duke duller dupe duplex duress dusk dust duvet dwarf dweeb eagle earful early " +
  "earwig easel easily easter eaten eatery eats ebay ebony ecard echo eclair edging edgy effort egging eggnog " +
  "eject elated elbow eleven elite elixir elude elves email ember emblem embody emcee emit empty enable enamel " +
  "encore ended ending engine engulf enrage enroll ensure entail entity entomb entrap envoy envy enzyme equal " +
  "equate erased eraser errand error erupt eskimo estate ether ethics even evict evil evolve exact excess exert " +
  "exes exhale exile exit expand expel expend expire expose extent fable fabric facial factor fade fading fall " +
  "false fame famine fancy fang faucet feast feeble feed feel feline femur fence ferret ferris ferry fester fetal " +
  "fetch fiber fiddle fifth figure filing filled film filter finale finch finer five flail flaky flap flashy " +
  "flask fled fleshy flick flight flinch fling flip flirt flock flop floral flyer flying foam folic folk follow " +
  "fondue font food footer fossil foster frail frame frayed freely french fresh friday fridge friend frill fringe " +
  "frolic from front froth frown frozen frying gaffe gains galley gallon galore gaming gamma gangly garage garden " +
  "garlic garnet garter gauze gave gawk gear gecko geek gender genre gently gerbil getup giant giddy gift giggly " +
  "gigolo gilled girdle given giver gizmo glade gladly glare glass glider glitzy gloomy glory glove glue gnarly " +
  "gnat goal going golf gonad gong good gooey google goon gopher gorged gory gossip gotten gout gown graded " +
  "grader granny grant grape grasp grass gravel gravy gray greedy grew grid grief grime grimy grinch grit groggy " +
  "groin groove groovy ground grout grove growl grub grudge grunt guide guise gully gulp gummy guru gush gusto " +
  "guts gutter hacked haiku half halved halves hamlet handed hangup hankie happy harbor hardly harsh hash hassle " +
  "hasty hatbox hate haunt haven hazard hazing hazy header heap heat hedge hefty helium helper hence henna herbal " +
  "herbs hermit hubcap huddle huff hulk hull humble humbly humid humped humvee hunger hunk hunter hurdle hurler " +
  "hurray hurry hush husked hybrid icing icky icon idiom idly ignore iguana image impart impish imply impure " +
  "iodine iodize iphone ipod irate issue item itunes jackal jacket jailer jaunt java jaws jazz jeep jersey jester " +
  "jiffy jimmy jingle jinx jogger john jolly jovial joyous judge juggle juice juicy jumble jumbo june junior " +
  "junkie juror jury justly karate karma kebab keep kelp kennel kettle kick kiln kimono kindle king kisser kite " +
  "kitty kiwi knee knoll koala kooky kudos kung ladder ladle lagged lagoon lake lance landed lapdog lapel laptop " +
  "lard large lash lasso last late lather latter laurel lavish lazily left legacy legal legged lego legume lend " +
  "length lent lesser letter levers liable life likely liking lilac lily limb limes line lingo lining lint lion " +
  "liquid list litmus little lived lively living lizard lucid lumber lunacy lunar lurch lure lurk luster lusty " +
  "luxury lyrics macaw maggot magma maimed making malt mama manger mangle mango manila manly manned mantis mantra " +
  "manual march mardi margin marine marlin marrow marry marshy mashed masses math matrix matron matted mauve " +
  "maybe mayday mobile mocha mocker modify module molar monday moody mooned morale morse mossy most motion motor " +
  "motto mouse mouth move movie mower mowing much mulch mule mulled mumbo mummy muppet mural murky mushy music " +
  "musket muster musty mutate mutiny mutt mutual myself myth nacho name naming nanny napkin napped narrow native " +
  "nature nearby nearly neatly nectar negate neon nerd nervy nest neuter never next niece nifty nimbly ninja " +
  "ninth nugget number numbly nutty nuzzle nylon object oblong oboe obtuse occupy ocean octane ogle oink olive " +
  "omega omit onion online onset onto onward oops ooze oozy open opium oppose otter ouch ought outage outbid " +
  "outer outing outlet outwit oval ovary oxford oxygen oyster paced pacify padded pagan pager paging palm paltry " +
  "panama pang panic pantry papaya paper parcel pardon parish parlor parole parrot partly party pasta pastel " +
  "pastor pasty path patio patrol paver paving payday payee payer pebble pebbly pecan pellet pelt pelvis penny " +
  "penpal perch perky perm pesky pester petal petite petted petty phoney phony photo plank plant plasma player " +
  "plaza pleat plenty plod plop plow ploy pluck plural plus poach poet pogo poise poison poker polar police " +
  "policy polish polka polo pond pony pope popper poppy pork portal portly poser posing possum posted poster " +
  "pouch pound pout power prance prayer precut prelaw prepay preppy press pretty prewar primal primer primp prior " +
  "prism prissy prize probe prong pronto proofs proton proud proved proxy prozac prude public pucker pueblo pulp " +
  "pulse pumice pummel punch pupil puppet puppy purge purify purist purple purr purse pushup pushy putt python " +
  "quack quail qualm quarry query quiet quill quirk quit quiver rabid race racing rack racoon radar radio radish " +
  "raffle rage ragged raging raisin rake rally ramble ramp ranch random ranged ranked rants rare rascal rash " +
  "ravage ravine raving reach reason rebate rebel reborn rebuff recant recast recede recess recite recoil record " +
  "recoup rectal reflex reflux refold refuse refute regain regime region reheat rehire rejoin relay relic relish " +
  "reload relock rely remark remedy remix remote rename rental renter reopen repair repeal repent reply repose " +
  "repost rerun resale reseal resent reset resize result resume retail retold retool retry retype reuse reveal " +
  "revert revise revolt reward rewash rewire reword rework rhyme ribbon rice richly ridden ride rift rigid rigor " +
  "rind rink rinse ripple rise risk ritzy rival roast robe robin rocker rocket rocky roman romp rope roster rosy " +
  "rotten roving royal rubbed rubble ruby rudder ruined rule rumor runner runny runway rural ruse rust sacred " +
  "sadden safari safely saga saggy said sake salad salami saline salon saloon salt salute same sandal sanded " +
  "sandy santa sappy sash satin saucy sauna saved savior scabby scale scam scarce scared scarf scenic scheme " +
  "scion scone scoop scope scored scorer scorn scouts scrap screen script scroll scuff scurvy second sector sedan " +
  "sedate seldom self senate senior sepia septic sequel series sermon sesame settle setup shack shaded shady " +
  "shaft shaky shame shank shanty share shawl sheath sheep sheet shelf shelve sherry shield shimmy shine ship " +
  "shirt shock shore shorts shorty shove shower shown shrank shriek shrill shrine shrink shrubs shrunk shun shush " +
  "siding sierra sift silent silica silly silo silt simile simple simply single sinner siren sitcom sitter sixth " +
  "sizing sizzle skater skewed skewer skied skier skies skinny skirt skype slacks slain slam slate slaw sled " +
  "sleep sleet sleeve sliced slicer slick slimy slinky slit sliver slogan sloppy slot sludge slum slurp slush " +
  "smell smile smirk smith smock smog smoky smooth smudgy smugly snack snare snarl snazzy sneer sneeze snide " +
  "snitch snooze snore snout snowy snub snugly speak specks speed spent sphere sphinx spider spiffy spill spilt " +
  "spiny spiral spleen spoils spoken sponge spoof spooky spool spore sports sporty spouse spout sprang sprawl " +
  "spray sprig spring sprint sprout spruce sprung spud spur squad squash squeak squid squire squirt stable staff " +
  "stage stand stank staple stark starry stash static statue status steam steed steep stench step stereo stick " +
  "stifle stilt stinky stir stock stoic stoke stomp stony stood stool stoop storm stove straw stray stream street " +
  "strep strewn strict strife strike strive strode struck strum strut stucco stuck study stuffy stump stunt " +
  "stupor sturdy suave sublet subpar suburb subway sudden sudoku suds sugar suing suitor sulk sullen sultry " +
  "supply surely surfer sushi swab swan sway swear sweat swell swept swipe swirl switch swoop swoosh swore swung " +
  "syrup system tables tablet tackle taco take taking tall talon tamale tamper tank taps target tarmac tartar " +
  "tartly task taste tasty tattle taunt tavern thank thaw thee theft these thesis thing think thinly thong thorn " +
  "those thread thrift thrill throat throng thud thus tiara tibia tidbit tidy tiger tiling till timid timing " +
  "tingle tinker tinsel tint tipoff tipped tipper tiring tissue trace trade train trance trash travel tray treble " +
  "tree trench trend triage tricky tried trifle tripod trophy trough trowel truce truck trunks truth tubby tumble " +
  "tummy turban turkey turret tusk tutor tutu tweed tweet twelve twerp twice twig twins twirl twisty tycoon tying " +
  "tyke ultra umpire unable unbent unclad unclip unclog uncork undead undone unease uneven unfair unfold unholy " +
  "unhook unify unison unit unkind unlit unmade unpaid unplug unread unrest unripe unroll unsafe unsaid unseen " +
  "unsnap unsold unsure untie until untold unused unwary unwed unwind unworn upbeat update upheld uphold upload " +
  "upon uproar uproot upside uptown upward upwind urchin urgent urging usage used user usual utmost utter vacant " +
  "vacate valium valley value vanity varied vastly vegan veggie velcro vendor venue venus verse versus very vest " +
  "veto vibes vice video violet violin viper virus visa vision vista vixen voice volley voter voting vowel voyage " +
  "waffle waged wager waggle wagon wake walk walnut walrus wand wanted wasabi washer wasp watch waving wavy " +
  "whacky wharf wheat whinny whiny whole wick widely widen widow width wife wilder wildly willed wilt wimp wince " +
  "wing winner winter wired wiring wisdom wise wish wizard wobble wobbly womb woof wooing woozy word work worst " +
  "wound woven wreath wrench wrist xerox yahoo yarn yeah yearly yelp yield yippee yoga yogurt yonder yummy zebra " +
  "zero zippy zips zodiac zone zoning "
).trim().split(" "));
